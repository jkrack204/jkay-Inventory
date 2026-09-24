-- Migration 005: query-speed indexes
--
-- No schema/behavior change — only adds indexes for the columns the app's
-- hottest queries actually filter on, which schema.sql/migration_002-004
-- didn't fully cover:
--   - inventory.items: every tree fetch filters `is_active = true`, and
--     usually also `location_id` (+ `kind`) at the same time — a composite
--     index lets Postgres satisfy that filter from the index alone instead
--     of scanning every item and checking each one.
--   - inventory.stock: previously only indexed via its (item_id, location_id)
--     primary key, whose leading column is item_id — a lookup by
--     location_id alone (reports.js's per-location stock queries) couldn't
--     use it. Same idea for a location-scoped DC list, which now has a
--     composite covering its two most common combined filters.
--
-- Harmless at the current data scale (a 2-location shop-floor tool), but
-- this is exactly the kind of thing that's cheap to add now and expensive
-- to notice missing later once the tables have years of DCs in them.
--
-- Safe to run any time: index-only, no table/column changes, no data
-- touched. Can be run standalone, independent of migration_003/004.

begin;

create index if not exists items_active_location_kind_idx
  on inventory.items(is_active, location_id, kind);

create index if not exists stock_location_idx
  on inventory.stock(location_id);

create index if not exists dcs_location_created_at_idx
  on inventory.dcs(location_id, created_at desc);

commit;
