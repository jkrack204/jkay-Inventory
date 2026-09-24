const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { resolveLocationId } = require('../middleware/auth');

const router = express.Router();

// A DC's creator can edit it for this long after it was recorded. Admin is
// exempt — see canEdit() below.
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

// Resolves { profileId -> full_name } for a set of ids in one query —
// used to attach "recorded by" / "last edited by" names without a raw SQL
// join (supabase-js can't join across schemas cleanly here since dcs and
// profiles are both already fetched separately elsewhere too).
async function profileNamesFor(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabaseAdmin
    .schema('inventory')
    .from('profiles')
    .select('id, full_name')
    .in('id', unique);
  if (error) return new Map();
  return new Map(data.map((p) => [p.id, p.full_name]));
}

// Whether `req.user` may edit this DC right now: admin always can;
// the DC's own creator can, but only within the 24h buffer.
function canEdit(req, dc) {
  if (req.user.role === 'admin') return true;
  if (dc.created_by !== req.user.id) return false;
  return Date.now() - new Date(dc.created_at).getTime() <= EDIT_WINDOW_MS;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// POST /api/dc — record an Input or Output DC (one or more lines) at a location.
// Available to any operator (scoped to their own location) or admin (must pass location_id).
// body: { direction: 'in'|'out', party, vehicle_no?, address?, note?, lines: [{ item_id, qty }] }
router.post('/', async (req, res, next) => {
  try {
    const locationId = resolveLocationId(req);
    if (!locationId) {
      return res.status(400).json({ error: 'location_id is required' });
    }

    let { party } = req.body;
    const { direction, vehicle_no, address, note, lines } = req.body;
    if (!['in', 'out'].includes(direction)) {
      return res.status(400).json({ error: "direction must be 'in' or 'out'" });
    }
    // Output DCs always need a named party (who it's going to). Input DCs
    // don't collect one in the UI — material just arrives — so default to
    // an empty string rather than requiring text nobody's asked to type.
    if (direction === 'out' && !party) {
      return res.status(400).json({ error: 'party is required' });
    }
    party = party || '';
    if (direction === 'out' && (!address || !vehicle_no)) {
      return res.status(400).json({ error: 'address and vehicle number are required for an Output DC' });
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'at least one line is required' });
    }
    for (const line of lines) {
      if (!line.item_id || !(Number(line.qty) > 0)) {
        return res.status(400).json({ error: 'each line needs item_id and a positive qty' });
      }
    }

    const { data, error } = await supabaseAdmin.schema('inventory').rpc('record_dc', {
      p_location_id: locationId,
      p_direction: direction,
      p_party: party,
      p_vehicle_no: vehicle_no || null,
      p_address: address || null,
      p_note: note || null,
      p_created_by: req.user.id,
      p_lines: lines.map((l) => ({ item_id: l.item_id, qty: l.qty })),
    });

    if (error) {
      // Insufficient stock and similar validation errors raised inside
      // record_dc surface here as a normal Postgres error message.
      const isStockError = /insufficient stock/i.test(error.message);
      return res.status(isStockError ? 409 : 400).json({ error: error.message });
    }

    res.status(201).json({ dc: data });
  } catch (err) {
    next(err);
  }
});

// GET /api/dc?location=&direction=&item=&party=&dc_no=&from=&to=&format=csv
// Operators see their own location's entries, no value. Admin sees value
// (qty × price, from the line snapshot) and can filter across locations.
// ?format=csv streams the same rows (one per DC line) as a CSV download
// instead of JSON, and raises the row cap since an export is meant to be
// complete, not a recent-activity preview.
router.get('/', async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const locationId = resolveLocationId(req);
    const { direction, item, party, dc_no, from, to, format } = req.query;
    const isCsv = format === 'csv';

    // When filtering by item, join dc_lines with !inner so the filter runs
    // in the database before the row cap — filtering in JS after a plain
    // (non-inner) select+limit would silently miss/undercount older
    // matching DCs at a location with more rows than the cap, since the
    // cap is applied to the *unfiltered* set first.
    const dcLinesSelect = item
      ? `dc_lines!inner(id, item_id, item_name, qty, unit, price)`
      : `dc_lines(id, item_id, item_name, qty, unit, price)`;
    let query = supabaseAdmin
      .schema('inventory')
      .from('dcs')
      .select(`id, dc_no, location_id, direction, party, vehicle_no, address, note, created_at, created_by, updated_at, edited_by, edit_count, ${dcLinesSelect}`)
      .order('created_at', { ascending: false })
      .limit(isCsv ? 5000 : 200);

    if (locationId) query = query.eq('location_id', locationId);
    if (direction) query = query.eq('direction', direction);
    if (dc_no) query = query.ilike('dc_no', `%${dc_no}%`);
    if (party) query = query.ilike('party', `%${party}%`);
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);
    if (item) query = query.eq('dc_lines.item_id', item);

    const { data, error } = await query;
    if (error) return res.status(400).json({ error: error.message });

    const [{ data: locations }, nameById] = await Promise.all([
      supabaseAdmin.schema('inventory').from('locations').select('id, name'),
      profileNamesFor(data.flatMap((dc) => [dc.created_by, dc.edited_by])),
    ]);
    const locNameById = new Map((locations || []).map((l) => [l.id, l.name]));

    // Strip price/value for non-admins; attach total value for admins.
    const rows = data.map((dc) => {
      const lines = dc.dc_lines.map((l) => ({
        id: l.id,
        item_id: l.item_id,
        item_name: l.item_name,
        qty: Number(l.qty),
        unit: l.unit,
        ...(isAdmin ? { price: Number(l.price), value: Number(l.qty) * Number(l.price) } : {}),
      }));
      return {
        id: dc.id,
        dc_no: dc.dc_no,
        location_id: dc.location_id,
        location_name: locNameById.get(dc.location_id) || null,
        direction: dc.direction,
        party: dc.party,
        vehicle_no: dc.vehicle_no,
        address: dc.address,
        note: dc.note,
        created_at: dc.created_at,
        created_by: dc.created_by,
        created_by_name: nameById.get(dc.created_by) || null,
        updated_at: dc.updated_at,
        edited_by_name: dc.edited_by ? nameById.get(dc.edited_by) || null : null,
        edit_count: dc.edit_count || 0,
        is_editable: canEdit(req, dc),
        lines,
        ...(isAdmin ? { total_value: lines.reduce((s, l) => s + l.value, 0) } : {}),
      };
    });

    if (isCsv) {
      const header = ['DC No', 'Direction', 'Location', 'Date', 'Party', 'Vehicle', 'Address', 'Note', 'Recorded by', 'Item', 'Qty', 'Unit'];
      if (isAdmin) header.push('Price', 'Value');
      const csvRows = [header];
      for (const dc of rows) {
        for (const l of dc.lines) {
          const row = [
            dc.dc_no,
            dc.direction === 'in' ? 'Input' : 'Output',
            dc.location_name,
            dc.created_at,
            dc.party,
            dc.vehicle_no,
            dc.address,
            dc.note,
            dc.created_by_name,
            l.item_name,
            l.qty,
            l.unit,
          ];
          if (isAdmin) row.push(l.price, l.value);
          csvRows.push(row);
        }
      }
      const csv = csvRows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="dcs-export-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(csv);
    }

    res.json({ dcs: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/dc/edits?location=&direction=&from=&to= — admin only: every edit
// made to any DC, across both locations, newest first — the global
// counterpart to /:id/history (which is scoped to one DC). Declared before
// the /:id routes below so "edits" is never swallowed as a DC id.
router.get('/edits', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { location, direction, from, to } = req.query;

    let query = supabaseAdmin
      .schema('inventory')
      .from('dc_edits')
      .select('id, dc_id, edited_by, edited_at, affected_stock, before_snapshot, after_snapshot, dcs!inner(id, dc_no, location_id, direction)')
      .order('edited_at', { ascending: false })
      .limit(500);
    if (location) query = query.eq('dcs.location_id', location);
    if (direction) query = query.eq('dcs.direction', direction);
    if (from) query = query.gte('edited_at', from);
    if (to) query = query.lte('edited_at', to);

    const { data, error } = await query;
    if (error) return res.status(400).json({ error: error.message });

    const [{ data: locations }, nameById] = await Promise.all([
      supabaseAdmin.schema('inventory').from('locations').select('id, name'),
      profileNamesFor(data.map((e) => e.edited_by)),
    ]);
    const locNameById = new Map((locations || []).map((l) => [l.id, l.name]));

    const edits = data.map((e) => ({
      id: e.id,
      dc_id: e.dc_id,
      dc_no: e.dcs?.dc_no,
      direction: e.dcs?.direction,
      location_id: e.dcs?.location_id,
      location_name: locNameById.get(e.dcs?.location_id) || null,
      edited_by: e.edited_by,
      edited_by_name: nameById.get(e.edited_by) || null,
      edited_at: e.edited_at,
      affected_stock: e.affected_stock,
      before_snapshot: e.before_snapshot,
      after_snapshot: e.after_snapshot,
    }));

    res.json({ edits });
  } catch (err) {
    next(err);
  }
});

// GET /api/dc/:id — single DC, formatted for the document view.
router.get('/:id', async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const { data: dc, error } = await supabaseAdmin
      .schema('inventory')
      .from('dcs')
      .select('id, dc_no, location_id, direction, party, vehicle_no, address, note, created_at, created_by, updated_at, edited_by, edit_count, dc_lines(id, item_id, item_name, qty, unit, price)')
      .eq('id', req.params.id)
      .single();

    if (error || !dc) return res.status(404).json({ error: 'DC not found' });

    if (!isAdmin && dc.location_id !== req.user.locationId) {
      return res.status(403).json({ error: 'Not your location' });
    }

    const [{ data: location }, nameById] = await Promise.all([
      supabaseAdmin.schema('inventory').from('locations').select('id, name').eq('id', dc.location_id).single(),
      profileNamesFor([dc.created_by, dc.edited_by]),
    ]);

    const lines = dc.dc_lines.map((l) => ({
      id: l.id,
      item_id: l.item_id,
      item_name: l.item_name,
      qty: Number(l.qty),
      unit: l.unit,
      ...(isAdmin ? { price: Number(l.price), value: Number(l.qty) * Number(l.price) } : {}),
    }));

    res.json({
      dc: {
        ...dc,
        dc_lines: undefined,
        location_name: location?.name || null,
        created_by_name: nameById.get(dc.created_by) || null,
        edited_by_name: dc.edited_by ? nameById.get(dc.edited_by) || null : null,
        is_editable: canEdit(req, dc),
        edit_window_hours: 24,
        lines,
        ...(isAdmin ? { total_value: lines.reduce((s, l) => s + l.value, 0) } : {}),
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/dc/:id — correct an existing DC's header + lines.
// The creator may edit their own DC within EDIT_WINDOW_MS of creating it.
// Admin may edit any DC at any time, and is the only one who can pass
// affect_stock: false to make a record-only correction (stock untouched).
// An operator's edit always affects stock — it's a genuine self-correction
// of a recent entry, not a bookkeeping override.
// body: { party?, vehicle_no?, address?, note?, lines: [{item_id, qty}], affect_stock? }
router.patch('/:id', async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const { data: existing, error: fetchError } = await supabaseAdmin
      .schema('inventory')
      .from('dcs')
      .select('id, location_id, direction, created_by, created_at')
      .eq('id', req.params.id)
      .single();
    if (fetchError || !existing) return res.status(404).json({ error: 'DC not found' });

    if (!isAdmin) {
      if (existing.location_id !== req.user.locationId) {
        return res.status(403).json({ error: 'Not your location' });
      }
      if (existing.created_by !== req.user.id) {
        return res.status(403).json({ error: 'You can only edit a DC you recorded yourself' });
      }
      if (Date.now() - new Date(existing.created_at).getTime() > EDIT_WINDOW_MS) {
        return res.status(403).json({ error: 'The 24-hour edit window for this DC has passed — ask an admin to make the correction' });
      }
    }

    const { party, vehicle_no, address, note, lines } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'at least one line is required' });
    }
    for (const line of lines) {
      if (!line.item_id || !(Number(line.qty) > 0)) {
        return res.status(400).json({ error: 'each line needs item_id and a positive qty' });
      }
    }
    // Only admin gets to decide an edit shouldn't move stock. Anyone else's
    // edit — the creator, within the buffer — always reconciles stock too.
    const affectStock = isAdmin ? req.body.affect_stock !== false : true;

    const { data, error } = await supabaseAdmin.schema('inventory').rpc('edit_dc', {
      p_dc_id: req.params.id,
      p_editor_id: req.user.id,
      p_party: party ?? null,
      p_vehicle_no: vehicle_no || null,
      p_address: address || null,
      p_note: note || null,
      p_lines: lines.map((l) => ({ item_id: l.item_id, qty: l.qty })),
      p_affect_stock: affectStock,
    });

    if (error) {
      const isStockError = /insufficient stock/i.test(error.message);
      return res.status(isStockError ? 409 : 400).json({ error: error.message });
    }

    res.json({ dc: data });
  } catch (err) {
    next(err);
  }
});

// GET /api/dc/:id/history — admin only: every edit made to this DC, newest
// first, with the editor's name and the full before/after snapshot.
router.get('/:id/history', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { data, error } = await supabaseAdmin
      .schema('inventory')
      .from('dc_edits')
      .select('id, dc_id, edited_by, edited_at, affected_stock, before_snapshot, after_snapshot')
      .eq('dc_id', req.params.id)
      .order('edited_at', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });

    const nameById = await profileNamesFor(data.map((e) => e.edited_by));
    const edits = data.map((e) => ({ ...e, edited_by_name: nameById.get(e.edited_by) || null }));
    res.json({ edits });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
