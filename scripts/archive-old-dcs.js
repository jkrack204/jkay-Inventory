#!/usr/bin/env node
/**
 * Delete-cycle for old DCs — keeps the live database small (and fast to
 * query) without ever losing the actual records: every DC older than the
 * retention window is exported to a CSV, uploaded to a Supabase Storage
 * bucket, and only THEN deleted from the live tables.
 *
 * Safe to run on any schedule: current stock (`inventory.stock`) is a
 * separate table that isn't derived from `dcs`/`dc_lines` at query time —
 * deleting old DC history never changes today's stock counts. Deleting a
 * `dcs` row cascades to its `dc_lines` and `dc_edits` automatically (both
 * have `on delete cascade` in db/schema.sql), so one delete covers all
 * three tables.
 *
 * Retention: DC_RETENTION_DAYS env var, default 2555 days (~7 years) —
 * chosen to comfortably clear India's GST/Income-Tax record-retention
 * expectation (~6 years), not because the database needs the space. At
 * realistic DC volumes for a 2-location shop, Supabase's free-tier 500MB
 * would take decades to fill even with NO retention limit at all — this
 * script exists for compliance-driven housekeeping, not storage pressure.
 *
 * Usage (manual):
 *   node scripts/archive-old-dcs.js
 *   node scripts/archive-old-dcs.js --dry-run   (report only, deletes nothing)
 *
 * Intended to run on a schedule via a Railway Cron Job service pointed at
 * this same repo, with the start command overridden to:
 *   node scripts/archive-old-dcs.js
 * See claude/JKAY_Inventory_Deploy_Plan.md for the Railway setup steps.
 *
 * Requires .env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const RETENTION_DAYS = Number(process.env.DC_RETENTION_DAYS || 2555); // ~7 years
const ARCHIVE_BUCKET = process.env.DC_ARCHIVE_BUCKET || 'dc-archives';
const DRY_RUN = process.argv.includes('--dry-run');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function profileNamesFor(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase.schema('inventory').from('profiles').select('id, full_name').in('id', unique);
  if (error) return new Map();
  return new Map(data.map((p) => [p.id, p.full_name]));
}

async function ensureBucket() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(`Could not list Storage buckets: ${error.message}`);
  if (buckets.some((b) => b.name === ARCHIVE_BUCKET)) return;
  const { error: createError } = await supabase.storage.createBucket(ARCHIVE_BUCKET, { public: false });
  if (createError) throw new Error(`Could not create "${ARCHIVE_BUCKET}" bucket: ${createError.message}`);
  console.log(`Created private Storage bucket "${ARCHIVE_BUCKET}" (first run).`);
}

async function main() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  console.log(`Archiving DCs created before ${cutoff.toISOString()} (retention: ${RETENTION_DAYS} days)${DRY_RUN ? ' — DRY RUN, nothing will be deleted' : ''}`);

  const { data: dcs, error } = await supabase
    .schema('inventory')
    .from('dcs')
    .select(`
      id, dc_no, location_id, direction, party, vehicle_no, address, note, created_at, created_by,
      dc_lines(item_name, qty, unit, price)
    `)
    .lt('created_at', cutoff.toISOString())
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Query failed: ${error.message}`);

  if (!dcs.length) {
    console.log('Nothing older than the retention window. Nothing to do.');
    return;
  }

  const [{ data: locations }, nameById] = await Promise.all([
    supabase.schema('inventory').from('locations').select('id, name'),
    profileNamesFor(dcs.map((d) => d.created_by)),
  ]);
  const locNameById = new Map((locations || []).map((l) => [l.id, l.name]));

  const header = ['DC No', 'Direction', 'Location', 'Date', 'Party', 'Vehicle', 'Address', 'Note', 'Recorded by', 'Item', 'Qty', 'Unit', 'Price', 'Value'];
  const rows = [header];
  for (const dc of dcs) {
    const lines = dc.dc_lines.length ? dc.dc_lines : [{ item_name: '', qty: '', unit: '', price: '' }];
    for (const l of lines) {
      rows.push([
        dc.dc_no,
        dc.direction === 'in' ? 'Input' : 'Output',
        locNameById.get(dc.location_id) || '',
        dc.created_at,
        dc.party,
        dc.vehicle_no,
        dc.address,
        dc.note,
        nameById.get(dc.created_by) || '',
        l.item_name,
        l.qty,
        l.unit,
        l.price,
        l.qty !== '' ? Number(l.qty) * Number(l.price || 0) : '',
      ]);
    }
  }
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const filename = `dc-archive-${cutoff.toISOString().slice(0, 10)}-run-${new Date().toISOString().slice(0, 10)}.csv`;

  console.log(`${dcs.length} DC(s) (${rows.length - 1} line rows) will be archived to "${ARCHIVE_BUCKET}/${filename}".`);

  if (DRY_RUN) {
    console.log('Dry run — stopping before upload/delete.');
    return;
  }

  await ensureBucket();
  const { error: uploadError } = await supabase.storage.from(ARCHIVE_BUCKET).upload(filename, csv, {
    contentType: 'text/csv; charset=utf-8',
    upsert: false,
  });
  if (uploadError) throw new Error(`CSV upload failed — stopping before any delete: ${uploadError.message}`);
  console.log('CSV uploaded. Proceeding to delete the archived rows from the live tables…');

  // Delete in batches so one run of many years' backlog doesn't attempt a
  // single giant statement. Deleting a dcs row cascades to its dc_lines and
  // dc_edits (see db/schema.sql) — no separate delete needed for those.
  const BATCH = 500;
  let deleted = 0;
  for (let i = 0; i < dcs.length; i += BATCH) {
    const ids = dcs.slice(i, i + BATCH).map((d) => d.id);
    const { error: deleteError } = await supabase.schema('inventory').from('dcs').delete().in('id', ids);
    if (deleteError) {
      throw new Error(
        `Delete failed after removing ${deleted} of ${dcs.length} rows (CSV already saved to "${ARCHIVE_BUCKET}/${filename}", safe to re-run): ${deleteError.message}`
      );
    }
    deleted += ids.length;
  }

  console.log(`Done. Archived and deleted ${deleted} DC(s). CSV: ${ARCHIVE_BUCKET}/${filename}`);
}

main().catch((err) => {
  console.error('archive-old-dcs failed:', err.message);
  process.exit(1);
});
