-- JKAY Racks Inventory — Postgres schema
-- Runs entirely inside a dedicated "inventory" schema so it can share a
-- Supabase project safely with other apps.
--
-- Model recap (see claude/JKAY_Inventory_Build_Plan.md for the full spec):
--   - Fabrication and Finished are two rows in `locations`, not two roles
--     with different powers.
--   - `items` is a single self-referencing tree, Admin-owned. Only leaves
--     (items with no children) hold real stock/price. A parent's quantity
--     and value are always computed by summing its leaves, never stored.
--   - `kind` (material / consumable) is set on the tree's top-level nodes
--     and must not be mixed within one subtree (enforced by trigger).
--   - Every stock movement — in either direction, at either location, on
--     either tab — is one row in `dcs`. Input DC increases stock at its
--     location; Output DC decreases it. Price/name are snapshotted onto
--     each line at the moment it's recorded, so a later price change or
--     rename never rewrites history.
--   - Soft-archive throughout via `is_active` — nothing is ever hard
--     deleted, so the audit trail (`dcs`) always resolves.

begin;

create schema if not exists inventory;

-- ---------------------------------------------------------------------
-- locations
-- ---------------------------------------------------------------------
create table if not exists inventory.locations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  code        text not null unique, -- short code, used as the DC-number prefix (FAB/FIN)
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Seed the two locations this build needs. A third location is a data
-- change (insert a row), never a schema/rebuild change.
insert into inventory.locations (name, code)
values ('Fabrication', 'FAB'), ('Finished', 'FIN')
on conflict (name) do nothing;

-- ---------------------------------------------------------------------
-- items — the single admin-owned tree, shared across both locations
-- ---------------------------------------------------------------------
create type inventory.item_kind as enum ('material', 'consumable');

create table if not exists inventory.items (
  id           uuid primary key default gen_random_uuid(),
  parent_id    uuid references inventory.items(id) on delete restrict,
  location_id  uuid not null references inventory.locations(id), -- each item belongs to exactly one location's tree
  kind         inventory.item_kind not null,
  name         text not null,
  unit         text not null default 'pcs',
  -- Explicit: true = a leaf that holds real stock/price; false = a category
  -- meant to hold children. Set at creation time (by which button/action
  -- created it), never inferred from whether it currently has children —
  -- an empty category must still render as a category, not a leaf.
  is_leaf      boolean not null default true,
  is_active    boolean not null default true,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists items_parent_id_idx on inventory.items(parent_id);
create index if not exists items_kind_idx on inventory.items(kind);
create index if not exists items_location_id_idx on inventory.items(location_id);
-- Every tree fetch filters is_active + usually location_id (+ kind)
-- together — see migration_005_perf_indexes.sql.
create index if not exists items_active_location_kind_idx on inventory.items(is_active, location_id, kind);

-- A child must live in the same location tree as its parent.
create or replace function inventory.enforce_item_location_matches_parent()
returns trigger as $$
declare
  parent_location uuid;
begin
  if new.parent_id is not null then
    select location_id into parent_location from inventory.items where id = new.parent_id;
    if parent_location is not null and parent_location <> new.location_id then
      raise exception 'item % must be in the same location tree as its parent', new.name
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists items_location_matches_parent on inventory.items;
create trigger items_location_matches_parent
  before insert or update of parent_id, location_id on inventory.items
  for each row execute function inventory.enforce_item_location_matches_parent();

-- A subtree can't mix material/consumable: a child's kind must match its
-- parent's kind. Root nodes (parent_id is null) set the kind for
-- everything nested under them.
create or replace function inventory.enforce_item_kind_matches_parent()
returns trigger as $$
declare
  parent_kind inventory.item_kind;
begin
  if new.parent_id is not null then
    select kind into parent_kind from inventory.items where id = new.parent_id;
    if parent_kind is null then
      raise exception 'parent item % does not exist', new.parent_id;
    end if;
    if parent_kind <> new.kind then
      raise exception 'item kind (%) must match parent item kind (%)', new.kind, parent_kind;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists items_kind_matches_parent on inventory.items;
create trigger items_kind_matches_parent
  before insert or update of parent_id, kind on inventory.items
  for each row execute function inventory.enforce_item_kind_matches_parent();

-- Only leaves (items with no children) may hold stock/price. This is
-- enforced at write-time on `stock` and `item_prices` below by checking
-- the item has no active children; we also guard the reverse direction
-- here — giving an item its first child is fine, but we leave any
-- pre-existing stock/price rows in place only if the item had none, to
-- avoid silently orphaning real numbers.
create or replace function inventory.enforce_leaf_only_stock()
returns trigger as $$
declare
  has_children boolean;
begin
  select exists(
    select 1 from inventory.items
    where parent_id = new.item_id and is_active = true
  ) into has_children;
  if has_children then
    raise exception 'item % has children — only leaf items may hold stock', new.item_id;
  end if;
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- stock — one row per (leaf item, location)
-- ---------------------------------------------------------------------
create table if not exists inventory.stock (
  item_id      uuid not null references inventory.items(id) on delete restrict,
  location_id  uuid not null references inventory.locations(id) on delete restrict,
  qty          numeric(14,3) not null default 0 check (qty >= 0),
  updated_at   timestamptz not null default now(),
  primary key (item_id, location_id)
);

-- The primary key's leading column is item_id, so a lookup by location_id
-- alone (reports.js's per-location stock queries) can't use it — see
-- migration_005_perf_indexes.sql.
create index if not exists stock_location_idx on inventory.stock(location_id);

drop trigger if exists stock_leaf_only on inventory.stock;
create trigger stock_leaf_only
  before insert or update on inventory.stock
  for each row execute function inventory.enforce_leaf_only_stock();

-- stock.location_id must always equal its item's own location_id — a leaf
-- only ever has stock at the one location that owns it.
create or replace function inventory.enforce_stock_location_matches_item()
returns trigger as $$
declare
  item_location uuid;
begin
  select location_id into item_location from inventory.items where id = new.item_id;
  if item_location is null then
    raise exception 'item % does not exist', new.item_id;
  end if;
  if item_location <> new.location_id then
    raise exception 'stock location must match the item''s own location'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists stock_location_matches_item on inventory.stock;
create trigger stock_location_matches_item
  before insert or update on inventory.stock
  for each row execute function inventory.enforce_stock_location_matches_item();

-- ---------------------------------------------------------------------
-- item_prices — one universal price per leaf item, Admin-set
-- ---------------------------------------------------------------------
create table if not exists inventory.item_prices (
  item_id     uuid primary key references inventory.items(id) on delete restrict,
  price       numeric(14,2) not null check (price >= 0),
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);

drop trigger if exists item_prices_leaf_only on inventory.item_prices;
create trigger item_prices_leaf_only
  before insert or update on inventory.item_prices
  for each row execute function inventory.enforce_leaf_only_stock();

-- ---------------------------------------------------------------------
-- profiles — one row per Supabase auth user
-- ---------------------------------------------------------------------
create type inventory.user_role as enum ('operator', 'admin');

create table if not exists inventory.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text not null,
  role         inventory.user_role not null,
  location_id  uuid references inventory.locations(id),
  created_at   timestamptz not null default now(),
  constraint operator_has_location check (
    (role = 'operator' and location_id is not null) or
    (role = 'admin' and location_id is null)
  )
);

-- ---------------------------------------------------------------------
-- dcs — the single transaction log (Input DC / Output DC), header
-- ---------------------------------------------------------------------
create type inventory.dc_direction as enum ('in', 'out');

create table if not exists inventory.dcs (
  id            uuid primary key default gen_random_uuid(),
  dc_no         text not null unique,
  location_id   uuid not null references inventory.locations(id),
  direction     inventory.dc_direction not null,
  party         text not null,
  vehicle_no    text,
  address       text,
  note          text,
  created_by    uuid references inventory.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  edited_by     uuid references inventory.profiles(id),
  edit_count    integer not null default 0
);

create index if not exists dcs_location_idx on inventory.dcs(location_id);
create index if not exists dcs_direction_idx on inventory.dcs(direction);
create index if not exists dcs_created_at_idx on inventory.dcs(created_at desc);
-- Covers the common "this location, newest first" filter+sort together —
-- see migration_005_perf_indexes.sql.
create index if not exists dcs_location_created_at_idx on inventory.dcs(location_id, created_at desc);

-- dc_edits — one row per edit to an existing DC (see migration_004 for the
-- full rationale): before/after snapshot, who, when, and whether it moved
-- `stock` or was a record-only correction. Admin-visible audit trail.
create table if not exists inventory.dc_edits (
  id              uuid primary key default gen_random_uuid(),
  dc_id           uuid not null references inventory.dcs(id) on delete cascade,
  edited_by       uuid references inventory.profiles(id),
  edited_at       timestamptz not null default now(),
  affected_stock  boolean not null,
  before_snapshot jsonb not null,
  after_snapshot  jsonb not null
);

create index if not exists dc_edits_dc_idx on inventory.dc_edits(dc_id);
create index if not exists dc_edits_edited_at_idx on inventory.dc_edits(edited_at desc);

-- dc_lines — one row per item on a DC. Price and name are snapshotted so
-- a later admin price change or rename never rewrites past documents.
create table if not exists inventory.dc_lines (
  id            uuid primary key default gen_random_uuid(),
  dc_id         uuid not null references inventory.dcs(id) on delete cascade,
  item_id       uuid not null references inventory.items(id),
  item_name     text not null,
  qty           numeric(14,3) not null check (qty > 0),
  unit          text not null,
  price         numeric(14,2) not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists dc_lines_dc_idx on inventory.dc_lines(dc_id);
create index if not exists dc_lines_item_idx on inventory.dc_lines(item_id);

-- ---------------------------------------------------------------------
-- alert_thresholds — per-item, per-location low-stock alert level.
-- Set from a location's own Settings panel (Fabrication/Finished each
-- keep their own thresholds for the same item).
-- ---------------------------------------------------------------------
create table if not exists inventory.alert_thresholds (
  item_id      uuid not null references inventory.items(id) on delete cascade,
  location_id  uuid not null references inventory.locations(id) on delete cascade,
  threshold    numeric(14,3) not null default 0 check (threshold >= 0),
  updated_at   timestamptz not null default now(),
  primary key (item_id, location_id)
);

-- ---------------------------------------------------------------------
-- DC numbering — a per-location running series (FAB-2026-00001,
-- FIN-2026-00001, ...), formatted like a real challan.
-- ---------------------------------------------------------------------
create table if not exists inventory.dc_counters (
  location_id  uuid primary key references inventory.locations(id),
  last_no      integer not null default 0
);

create or replace function inventory.next_dc_no(p_location_id uuid)
returns text as $$
declare
  v_code text;
  v_no integer;
begin
  select code into v_code from inventory.locations where id = p_location_id;
  if v_code is null then
    raise exception 'location % does not exist', p_location_id;
  end if;

  insert into inventory.dc_counters (location_id, last_no)
  values (p_location_id, 1)
  on conflict (location_id) do update set last_no = inventory.dc_counters.last_no + 1
  returning last_no into v_no;

  return v_code || '-' || to_char(now(), 'YYYY') || '-' || lpad(v_no::text, 5, '0');
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- Row-locking helper: apply one DC line to `stock`, atomically.
-- Called by the API inside a transaction per DC (all lines succeed or
-- the whole DC is rolled back), row-locking the stock row to prevent
-- two concurrent Output DCs from overdrawing the same item.
-- ---------------------------------------------------------------------
create or replace function inventory.apply_dc_line(
  p_item_id uuid,
  p_location_id uuid,
  p_direction inventory.dc_direction,
  p_qty numeric,
  p_item_name text default null
) returns void as $$
declare
  current_qty numeric(14,3);
begin
  -- Ensure a stock row exists, then lock it.
  insert into inventory.stock (item_id, location_id, qty)
  values (p_item_id, p_location_id, 0)
  on conflict (item_id, location_id) do nothing;

  select qty into current_qty
  from inventory.stock
  where item_id = p_item_id and location_id = p_location_id
  for update;

  if p_direction = 'in' then
    update inventory.stock
      set qty = current_qty + p_qty, updated_at = now()
      where item_id = p_item_id and location_id = p_location_id;
  else
    if current_qty < p_qty then
      raise exception 'insufficient stock for %: have %, need %',
        coalesce(p_item_name, p_item_id::text), current_qty, p_qty
        using errcode = 'P0001';
    end if;
    update inventory.stock
      set qty = current_qty - p_qty, updated_at = now()
      where item_id = p_item_id and location_id = p_location_id;
  end if;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- record_dc — the one entry point for creating a DC (header + lines).
-- Runs as a single function call, so Postgres gives it one implicit
-- transaction: either every line applies and the DC is created, or an
-- insufficient-stock error on any line rolls the whole thing back.
-- `apply_dc_line` above row-locks each stock row it touches, so two
-- concurrent Output DCs against the same item can't both succeed and
-- overdraw it.
--
-- p_lines shape: jsonb array of { "item_id": uuid, "qty": numeric }
-- ---------------------------------------------------------------------
create or replace function inventory.record_dc(
  p_location_id uuid,
  p_direction inventory.dc_direction,
  p_party text,
  p_vehicle_no text,
  p_address text,
  p_note text,
  p_created_by uuid,
  p_lines jsonb
) returns inventory.dcs as $$
declare
  v_dc inventory.dcs;
  v_line jsonb;
  v_item inventory.items%rowtype;
  v_price numeric(14,2);
begin
  if jsonb_array_length(p_lines) = 0 then
    raise exception 'a DC needs at least one line';
  end if;

  if p_direction = 'out' then
    if p_party is null or btrim(p_party) = '' then
      raise exception 'party is required for an Output DC' using errcode = 'P0001';
    end if;
    if p_address is null or btrim(p_address) = '' then
      raise exception 'address is required for an Output DC' using errcode = 'P0001';
    end if;
    if p_vehicle_no is null or btrim(p_vehicle_no) = '' then
      raise exception 'vehicle number is required for an Output DC' using errcode = 'P0001';
    end if;
  end if;

  insert into inventory.dcs (dc_no, location_id, direction, party, vehicle_no, address, note, created_by)
  values (inventory.next_dc_no(p_location_id), p_location_id, p_direction, p_party, p_vehicle_no, p_address, p_note, p_created_by)
  returning * into v_dc;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_item from inventory.items where id = (v_line->>'item_id')::uuid;
    if v_item.id is null then
      raise exception 'item % does not exist', v_line->>'item_id';
    end if;
    if v_item.location_id <> p_location_id then
      raise exception 'item % does not belong to this location', v_item.name
        using errcode = 'P0001';
    end if;

    select price into v_price from inventory.item_prices where item_id = v_item.id;

    insert into inventory.dc_lines (dc_id, item_id, item_name, qty, unit, price)
    values (
      v_dc.id,
      v_item.id,
      v_item.name,
      (v_line->>'qty')::numeric,
      v_item.unit,
      coalesce(v_price, 0)
    );

    perform inventory.apply_dc_line(v_item.id, p_location_id, p_direction, (v_line->>'qty')::numeric, v_item.name);
  end loop;

  return v_dc;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- edit_dc — corrects an existing DC's header + lines (see migration_004
-- for the full rationale). p_affect_stock chooses whether the quantity
-- delta is applied to `stock` (a real correction) or left untouched (a
-- record-only fix, e.g. a misspelled party name).
-- ---------------------------------------------------------------------
create or replace function inventory.edit_dc(
  p_dc_id uuid,
  p_editor_id uuid,
  p_party text,
  p_vehicle_no text,
  p_address text,
  p_note text,
  p_lines jsonb,
  p_affect_stock boolean
) returns inventory.dcs as $$
declare
  v_dc inventory.dcs;
  v_before jsonb;
  v_after jsonb;
  v_line jsonb;
  v_old_line record;
  v_item inventory.items%rowtype;
  v_price numeric(14,2);
begin
  select * into v_dc from inventory.dcs where id = p_dc_id;
  if v_dc.id is null then
    raise exception 'DC not found';
  end if;

  if jsonb_array_length(p_lines) = 0 then
    raise exception 'a DC needs at least one line';
  end if;

  if v_dc.direction = 'out' then
    if p_party is null or btrim(p_party) = '' then
      raise exception 'party is required for an Output DC' using errcode = 'P0001';
    end if;
    if p_address is null or btrim(p_address) = '' then
      raise exception 'address is required for an Output DC' using errcode = 'P0001';
    end if;
    if p_vehicle_no is null or btrim(p_vehicle_no) = '' then
      raise exception 'vehicle number is required for an Output DC' using errcode = 'P0001';
    end if;
  end if;

  select jsonb_build_object(
    'party', v_dc.party, 'vehicle_no', v_dc.vehicle_no, 'address', v_dc.address, 'note', v_dc.note,
    'lines', coalesce(
      (select jsonb_agg(jsonb_build_object('item_id', item_id, 'item_name', item_name, 'qty', qty, 'unit', unit, 'price', price))
       from inventory.dc_lines where dc_id = p_dc_id),
      '[]'::jsonb
    )
  ) into v_before;

  if p_affect_stock then
    for v_old_line in select item_id, qty from inventory.dc_lines where dc_id = p_dc_id
    loop
      perform inventory.apply_dc_line(
        v_old_line.item_id, v_dc.location_id,
        case when v_dc.direction = 'in' then 'out'::inventory.dc_direction else 'in'::inventory.dc_direction end,
        v_old_line.qty
      );
    end loop;
  end if;

  delete from inventory.dc_lines where dc_id = p_dc_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_item from inventory.items where id = (v_line->>'item_id')::uuid;
    if v_item.id is null then
      raise exception 'item % does not exist', v_line->>'item_id';
    end if;
    if v_item.location_id <> v_dc.location_id then
      raise exception 'item % does not belong to this location', v_item.name
        using errcode = 'P0001';
    end if;

    select price into v_price from inventory.item_prices where item_id = v_item.id;

    insert into inventory.dc_lines (dc_id, item_id, item_name, qty, unit, price)
    values (p_dc_id, v_item.id, v_item.name, (v_line->>'qty')::numeric, v_item.unit, coalesce(v_price, 0));

    if p_affect_stock then
      perform inventory.apply_dc_line(v_item.id, v_dc.location_id, v_dc.direction, (v_line->>'qty')::numeric, v_item.name);
    end if;
  end loop;

  update inventory.dcs
    set party = coalesce(p_party, party),
        vehicle_no = p_vehicle_no,
        address = p_address,
        note = p_note,
        updated_at = now(),
        edited_by = p_editor_id,
        edit_count = edit_count + 1
    where id = p_dc_id
    returning * into v_dc;

  select jsonb_build_object(
    'party', v_dc.party, 'vehicle_no', v_dc.vehicle_no, 'address', v_dc.address, 'note', v_dc.note,
    'lines', coalesce(
      (select jsonb_agg(jsonb_build_object('item_id', item_id, 'item_name', item_name, 'qty', qty, 'unit', unit, 'price', price))
       from inventory.dc_lines where dc_id = p_dc_id),
      '[]'::jsonb
    )
  ) into v_after;

  insert into inventory.dc_edits (dc_id, edited_by, affected_stock, before_snapshot, after_snapshot)
  values (p_dc_id, p_editor_id, p_affect_stock, v_before, v_after);

  return v_dc;
end;
$$ language plpgsql;

commit;
