-- Migration 008: permanent delete of an item / branch (whole subtree).
--
-- delete_item_subtree(p_id, p_dry_run):
--   p_dry_run = true  -> only returns the impact counts, changes nothing.
--   p_dry_run = false -> permanently removes, atomically (one transaction):
--       DC lines of every item in the subtree, DCs left with no lines,
--       stock rows, prices, alert thresholds, then the items themselves.
-- Past ledgers / DCs lose the deleted lines (by design - admin chose
-- "permanent delete even with history").
create or replace function inventory.delete_item_subtree(p_id uuid, p_dry_run boolean default true)
returns jsonb
language plpgsql
as $$
declare
  v_ids uuid[];
  v_items int; v_stock int; v_lines int; v_dcs int; v_empty uuid[];
begin
  with recursive sub as (
    select id from inventory.items where id = p_id
    union all
    select i.id from inventory.items i join sub s on i.parent_id = s.id
  )
  select array_agg(id) into v_ids from sub;

  if v_ids is null then
    raise exception 'Item not found';
  end if;

  v_items := array_length(v_ids, 1);
  select count(*) into v_stock from inventory.stock where item_id = any(v_ids);
  select count(*), count(distinct dc_id) into v_lines, v_dcs from inventory.dc_lines where item_id = any(v_ids);

  -- DCs that would have no lines left once these lines are gone
  select array_agg(d.dc_id) into v_empty from (
    select dc_id from inventory.dc_lines group by dc_id
    having count(*) filter (where item_id <> all(v_ids)) = 0
       and count(*) filter (where item_id = any(v_ids)) > 0
  ) d;

  if not p_dry_run then
    delete from inventory.dc_lines where item_id = any(v_ids);
    if v_empty is not null then
      delete from inventory.dcs where id = any(v_empty);
    end if;
    delete from inventory.stock where item_id = any(v_ids);
    delete from inventory.item_prices where item_id = any(v_ids);
    delete from inventory.alert_thresholds where item_id = any(v_ids);
    update inventory.items set parent_id = null where id = any(v_ids);
    delete from inventory.items where id = any(v_ids);
  end if;

  return jsonb_build_object(
    'items', v_items, 'stock_rows', v_stock, 'dc_lines', v_lines,
    'dcs_affected', v_dcs, 'dcs_removed', coalesce(array_length(v_empty, 1), 0)
  );
end;
$$;
