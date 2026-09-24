-- Migration 002: per-location item trees + per-location DC numbering +
-- mandatory Output DC fields.
--
-- Supersedes the "one shared item tree" model from migration 001. Per the
-- updated build spec: each location owns its own item tree entirely; the
-- only thing that stays universal across both is price.
--
-- FRESH START: this wipes existing items/stock/prices/DCs/thresholds
-- (test data only — locations and profiles/logins are untouched).

begin;

-- ---------------------------------------------------------------------
-- 0. Wipe existing transactional/tree data (fresh start, per decision).
--    Order matters: children before parents.
-- ---------------------------------------------------------------------
truncate table inventory.dc_lines cascade;
truncate table inventory.dcs cascade;
truncate table inventory.alert_thresholds cascade;
truncate table inventory.stock cascade;
truncate table inventory.item_prices cascade;
truncate table inventory.items cascade;

-- ---------------------------------------------------------------------
-- 1. Locations get a short code, used as the DC-number prefix.
-- ---------------------------------------------------------------------
alter table inventory.locations add column if not exists code text;
update inventory.locations set code = 'FAB' where name = 'Fabrication' and code is null;
update inventory.locations set code = 'FIN' where name = 'Finished' and code is null;
alter table inventory.locations alter column code set not null;
alter table inventory.locations add constraint locations_code_unique unique (code);

-- ---------------------------------------------------------------------
-- 2. items now belongs to exactly one location's tree.
-- ---------------------------------------------------------------------
alter table inventory.items add column if not exists location_id uuid references inventory.locations(id);
alter table inventory.items alter column location_id set not null;
create index if not exists items_location_id_idx on inventory.items(location_id);

-- A child must live in the same location tree as its parent (belt & braces
-- alongside the application layer, which always sets location_id from the
-- parent when creating a sub-item).
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

-- ---------------------------------------------------------------------
-- 3. stock.location_id must always equal its item's own location_id —
--    each item's stock now only ever exists at the one location that
--    owns it (no more "same leaf visible at both locations").
-- ---------------------------------------------------------------------
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
-- 4. DC numbering becomes a per-location running series (e.g. FAB-2026-00001,
--    FIN-2026-00001), replacing the single global sequence.
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

-- Old global sequence/function are no longer used.
drop function if exists inventory.next_dc_no();

-- ---------------------------------------------------------------------
-- 5. record_dc: use the new per-location numbering, require every item on
--    the DC to belong to that location's own tree, and require party +
--    address + vehicle_no (all three) on every Output DC.
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

commit;
