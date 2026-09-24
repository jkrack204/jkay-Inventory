-- Migration 004: DC edit history + editable-with-a-buffer DCs
--
-- Adds the ability to correct a DC after it's recorded:
--   - The person who created it can edit it within a 24-hour buffer
--     (enforced by the API, using dcs.created_at/created_by — no schema
--     change needed for that check itself).
--   - Admin can edit any DC at any time, and chooses per-edit whether the
--     new quantities should move `stock` (a real correction) or not (a
--     record-only fix, e.g. a misspelled party name, that leaves the
--     physical count alone).
--   - Every edit is logged to `dc_edits` — full before/after snapshot,
--     who, when, and whether it touched stock — visible to admin as an
--     audit trail. Nothing is ever overwritten silently.
--
-- Safe to run any time: additive columns/table only.

begin;

alter table inventory.dcs
  add column if not exists updated_at timestamptz,
  add column if not exists edited_by  uuid references inventory.profiles(id),
  add column if not exists edit_count integer not null default 0;

-- dc_edits — one row per edit, full before/after snapshot of the header
-- fields + line items, so admin can see exactly what changed without
-- reconstructing it from a diff.
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

-- edit_dc — the one entry point for correcting an existing DC's header +
-- lines. Runs as a single function call (one implicit transaction): the
-- stock reversal/reapplication, the line replacement, the header update,
-- and the audit-log insert either all happen or none do.
--
-- p_affect_stock = true : reverses every existing line's effect on
--   `stock` (opposite direction of the DC), then applies the new lines'
--   effect — a real correction to the physical count. Can fail with an
--   "insufficient stock" error if later transactions already consumed
--   what this edit would reverse (e.g. shrinking an old Input DC after
--   that stock has since been issued out) — this is intentional, the
--   same protection as a normal Output DC.
-- p_affect_stock = false: only the record (party/vehicle/address/note/
--   line names/quantities-as-displayed) changes; `stock` is left exactly
--   as it was. Use for record-only corrections, e.g. a misspelled party
--   name — never for a quantity fix that should also move stock.
--
-- p_lines shape: jsonb array of { "item_id": uuid, "qty": numeric }
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
