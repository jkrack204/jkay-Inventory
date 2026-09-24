-- Migration 003: explicit is_leaf flag on items
--
-- Bug: whether a node renders as a category (holds children) or a leaf
-- (holds stock/price) was inferred purely from whether it CURRENTLY has
-- children. That means a freshly-created empty category is indistinguishable
-- from a leaf the instant it's created — it shows up with 0 stock, leaf-only
-- actions (Change price / Low-stock alert), and no way to add anything under
-- it. This adds a real, stored flag so category-vs-leaf is a decision made
-- at creation time, not inferred from current tree shape.
--
-- Safe to run any time: additive column, backfilled from the current tree
-- shape (so nothing that already has children flips to leaf), no data loss.

begin;

alter table inventory.items
  add column if not exists is_leaf boolean not null default true;

-- Backfill: anything that currently has an active child is provably a
-- category, regardless of what the new column's default says.
update inventory.items i
set is_leaf = false
where exists (
  select 1 from inventory.items c
  where c.parent_id = i.id and c.is_active = true
);

commit;
