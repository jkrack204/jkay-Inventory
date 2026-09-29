-- Migration 007: manual item order
--
-- Admin can now drag items (and top-level branches) up/down to set a
-- custom display order among siblings, instead of the tree always being
-- alphabetical. `sort_order` is the rank within a sibling group — all
-- items sharing the same `parent_id` (top-level items also share the
-- implicit group "no parent, same location"). Lower sorts first.
--
-- Backfilled from the current alphabetical order so nothing visually
-- jumps around the first time this ships; every reorder from then on is
-- saved via PATCH /api/items/reorder.

alter table inventory.items add column if not exists sort_order integer;

with ranked as (
  select id, row_number() over (partition by location_id, parent_id order by name) - 1 as rn
  from inventory.items
)
update inventory.items i
set sort_order = ranked.rn
from ranked
where ranked.id = i.id
  and i.sort_order is null;

alter table inventory.items alter column sort_order set default 0;
alter table inventory.items alter column sort_order set not null;

create index if not exists items_parent_sort_idx on inventory.items(parent_id, sort_order);
