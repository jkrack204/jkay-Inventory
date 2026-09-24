const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAdmin, resolveLocationId } = require('../middleware/auth');

const router = express.Router();

// GET /api/out-of-stock?location= — leaf items at zero quantity.
// Admin: across all locations (or one, via ?location=). Operators: their own only.
router.get('/out-of-stock', async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const locationId = resolveLocationId(req);

    let itemsQuery = supabaseAdmin
      .schema('inventory')
      .from('items')
      .select('id, name, unit, kind, location_id')
      .eq('is_active', true);
    const { data: items, error: itemsError } = await itemsQuery;
    if (itemsError) return res.status(400).json({ error: itemsError.message });

    let locQuery = supabaseAdmin.schema('inventory').from('locations').select('id, name').eq('is_active', true);
    if (locationId) locQuery = locQuery.eq('id', locationId);
    const { data: locations, error: locError } = await locQuery;
    if (locError) return res.status(400).json({ error: locError.message });

    const { data: stockRows, error: stockError } = await supabaseAdmin
      .schema('inventory')
      .from('stock')
      .select('item_id, location_id, qty');
    if (stockError) return res.status(400).json({ error: stockError.message });

    // A leaf is any item id that appears in `stock` at all (parents never
    // do). Each item now belongs to exactly one location's tree, so we
    // only ever check it against that one location — not every location.
    const leafIds = new Set(stockRows.map((r) => r.item_id));
    const stockByItem = new Map(stockRows.map((r) => [r.item_id, Number(r.qty)]));
    const locById = new Map(locations.map((l) => [l.id, l]));

    const out = [];
    for (const item of items) {
      if (!leafIds.has(item.id)) continue;
      const loc = locById.get(item.location_id);
      if (!loc) continue; // filtered out by ?location= or inactive
      const qty = stockByItem.get(item.id) ?? 0;
      if (qty === 0) {
        out.push({ item_id: item.id, item_name: item.name, unit: item.unit, kind: item.kind, location_id: loc.id, location_name: loc.name });
      }
    }

    res.json({ out_of_stock: out });
  } catch (err) {
    next(err);
  }
});

// GET /api/low-stock?location= — leaf items at or below their alert threshold (but > 0; use out-of-stock for zero).
router.get('/low-stock', async (req, res, next) => {
  try {
    const locationId = resolveLocationId(req);
    if (!locationId) return res.status(400).json({ error: 'location is required' });

    const { data: thresholds, error: thresholdError } = await supabaseAdmin
      .schema('inventory')
      .from('alert_thresholds')
      .select('item_id, threshold')
      .eq('location_id', locationId);
    if (thresholdError) return res.status(400).json({ error: thresholdError.message });
    if (!thresholds.length) return res.json({ low_stock: [] });

    const itemIds = thresholds.map((t) => t.item_id);
    const { data: stockRows, error: stockError } = await supabaseAdmin
      .schema('inventory')
      .from('stock')
      .select('item_id, qty')
      .eq('location_id', locationId)
      .in('item_id', itemIds);
    if (stockError) return res.status(400).json({ error: stockError.message });

    const { data: items, error: itemsError } = await supabaseAdmin
      .schema('inventory')
      .from('items')
      .select('id, name, unit')
      .in('id', itemIds);
    if (itemsError) return res.status(400).json({ error: itemsError.message });

    const itemById = new Map(items.map((i) => [i.id, i]));
    const qtyByItem = new Map(stockRows.map((r) => [r.item_id, Number(r.qty)]));

    const low = thresholds
      .map((t) => {
        const qty = qtyByItem.get(t.item_id) ?? 0;
        const item = itemById.get(t.item_id);
        return { item_id: t.item_id, item_name: item?.name, unit: item?.unit, qty, threshold: Number(t.threshold) };
      })
      .filter((row) => row.qty > 0 && row.qty <= row.threshold);

    res.json({ low_stock: low });
  } catch (err) {
    next(err);
  }
});

// PUT /api/low-stock/:itemId — set this location's alert threshold for an item.
// Available to operators (their own location) and admin (any, via ?location=).
router.put('/low-stock/:itemId', async (req, res, next) => {
  try {
    const locationId = resolveLocationId(req);
    if (!locationId) return res.status(400).json({ error: 'location is required' });
    const { threshold } = req.body;
    if (!(Number(threshold) >= 0)) return res.status(400).json({ error: 'threshold must be >= 0' });

    const { error } = await supabaseAdmin
      .schema('inventory')
      .from('alert_thresholds')
      .upsert(
        { item_id: req.params.itemId, location_id: locationId, threshold, updated_at: new Date().toISOString() },
        { onConflict: 'item_id,location_id' }
      );
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/valuation?location= — admin only: totals (price × qty) per location and overall, rolled up through the tree.
router.get('/valuation', requireAdmin, async (req, res, next) => {
  try {
    const { location } = req.query;

    let locQuery = supabaseAdmin.schema('inventory').from('locations').select('id, name').eq('is_active', true);
    if (location) locQuery = locQuery.eq('id', location);
    const { data: locations, error: locError } = await locQuery;
    if (locError) return res.status(400).json({ error: locError.message });

    const { data: stockRows, error: stockError } = await supabaseAdmin
      .schema('inventory')
      .from('stock')
      .select('item_id, location_id, qty');
    if (stockError) return res.status(400).json({ error: stockError.message });

    const { data: prices, error: priceError } = await supabaseAdmin
      .schema('inventory')
      .from('item_prices')
      .select('item_id, price');
    if (priceError) return res.status(400).json({ error: priceError.message });

    const priceByItem = new Map(prices.map((p) => [p.item_id, Number(p.price)]));

    const perLocation = locations.map((loc) => {
      const rows = stockRows.filter((r) => r.location_id === loc.id);
      const total_qty = rows.reduce((s, r) => s + Number(r.qty), 0);
      const total_value = rows.reduce((s, r) => s + Number(r.qty) * (priceByItem.get(r.item_id) || 0), 0);
      return { location_id: loc.id, location_name: loc.name, total_qty, total_value };
    });

    const overall_value = perLocation.reduce((s, l) => s + l.total_value, 0);
    const overall_qty = perLocation.reduce((s, l) => s + l.total_qty, 0);

    res.json({ per_location: perLocation, overall: { total_qty: overall_qty, total_value: overall_value } });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory-books?item_id=&location=&from=&to=
// Ledger view: opening balance, every DC line touching the item at that
// location (inward/outward qty, running balance), closing balance.
router.get('/inventory-books', async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const locationId = resolveLocationId(req);
    const { item_id, from, to } = req.query;

    if (!item_id) return res.status(400).json({ error: 'item_id is required' });
    if (!locationId) return res.status(400).json({ error: 'location is required' });

    // Pull every DC line for this item at this location, oldest first, so
    // we can walk forward and compute a running balance.
    let query = supabaseAdmin
      .schema('inventory')
      .from('dc_lines')
      .select('id, qty, price, dc_id, dcs!inner(id, dc_no, direction, party, location_id, created_at)')
      .eq('item_id', item_id)
      .eq('dcs.location_id', locationId)
      .order('created_at', { referencedTable: 'dcs', ascending: true });

    if (from) query = query.gte('dcs.created_at', from);
    if (to) query = query.lte('dcs.created_at', to);

    const { data: rows, error } = await query;
    if (error) return res.status(400).json({ error: error.message });

    // Opening balance = current stock minus every movement from the start
    // of the window up to *now* — not up to `to`. Walking backward from
    // today's actual stock only cancels out correctly over that full span;
    // if `to` is set, `rows` (used below for the displayed entries and the
    // running balance) stops at `to`, so movements between `to` and now
    // would otherwise go uncounted and throw off every balance in the
    // ledger by that missing net amount. Fetch that net separately, scoped
    // to `from` only, regardless of `to`.
    let openingQuery = supabaseAdmin
      .schema('inventory')
      .from('dc_lines')
      .select('qty, dcs!inner(direction, location_id, created_at)')
      .eq('item_id', item_id)
      .eq('dcs.location_id', locationId);
    if (from) openingQuery = openingQuery.gte('dcs.created_at', from);
    const { data: openingRows, error: openingError } = await openingQuery;
    if (openingError) return res.status(400).json({ error: openingError.message });

    const { data: stockRow } = await supabaseAdmin
      .schema('inventory')
      .from('stock')
      .select('qty')
      .eq('item_id', item_id)
      .eq('location_id', locationId)
      .maybeSingle();

    const currentQty = Number(stockRow?.qty ?? 0);
    const netSinceFrom = openingRows.reduce((s, r) => s + (r.dcs.direction === 'in' ? Number(r.qty) : -Number(r.qty)), 0);
    const opening = currentQty - netSinceFrom;

    let running = opening;
    const entries = rows.map((r) => {
      running += r.dcs.direction === 'in' ? Number(r.qty) : -Number(r.qty);
      return {
        dc_id: r.dcs.id,
        dc_no: r.dcs.dc_no,
        direction: r.dcs.direction,
        party: r.dcs.party,
        created_at: r.dcs.created_at,
        qty: Number(r.qty),
        balance: running,
        ...(isAdmin ? { price: Number(r.price), value: Number(r.qty) * Number(r.price) } : {}),
      };
    });

    res.json({ item_id, location_id: locationId, opening_balance: opening, closing_balance: running, entries });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
