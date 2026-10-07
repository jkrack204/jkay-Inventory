-- Migration 009: remove a stale 4-argument overload of apply_dc_line.
-- The current function has a 5th argument with a default (p_item_name),
-- so a call with 4 arguments matched BOTH versions and failed with
-- "function inventory.apply_dc_line(uuid, uuid, dc_direction, numeric) is not unique"
-- (seen when editing a DC with "Apply this change to stock" ticked).
drop function if exists inventory.apply_dc_line(uuid, uuid, inventory.dc_direction, numeric);
