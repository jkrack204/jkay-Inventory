const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAdmin, resolveLocationId, resolvePeekLocationId } = require('../middleware/auth');

const router = express.Router();

/**
 * Builds the item tree (optionally filtered by kind) with:
 *   - qty at the given location(s), rolled up from leaves to parents
 *   - price, only attached when includePrice is true (admin requests)
 *
 * Each item now belongs to exactly one location's tree (`items.location_id`),
 * so `locationIds` both scopes which items are fetched at all and which
 * stock rows apply — there's no longer a "same leaf at both locations"
 * case, but admin's global view (locationIds = null) still spans both trees.
 */
async function buildTree({ kind, locationIds, includePrice }) {
  let itemsQuery = supabaseAdmin
    .schema('inventory')
    .from('items')
    .select('id, parent_id, location_id, kind, name, unit, is_active, is_leaf')
    .eq('is_active', true)
    .order('name');
  if (kind) itemsQuery = itemsQuery.eq('kind', kind);
  if (locationIds) itemsQuery = itemsQuery.in('location_id', locationIds);

  const { data: items, error: itemsError } = await itemsQuery;
  if (itemsError) throw itemsError;

  const ids = items.map((i) => i.id);
  let stockByItemByLocation = {};
  let priceByItem = {};

  if (ids.length) {
    // stock and price rows both only depend on `ids`, not on each other —
    // fire them together instead of one after the other.
    const stockQuery = supabaseAdmin.schema('inventory').from('stock').select('item_id, location_id, qty').in('item_id', ids);
    const priceQuery = includePrice
      ? supabaseAdmin.schema('inventory').from('item_prices').select('item_id, price').in('item_id', ids)
      : Promise.resolve({ data: [], error: null });

    const [{ data: stockRows, error: stockError }, { data: priceRows, error: priceError }] = await Promise.all([
      stockQuery,
      priceQuery,
    ]);
    if (stockError) throw stockError;
    if (priceError) throw priceError;

    for (const row of stockRows) {
      if (locationIds && !locationIds.includes(row.location_id)) continue;
      stockByItemByLocation[row.item_id] = stockByItemByLocation[row.item_id] || {};
      stockByItemByLocation[row.item_id][row.location_id] =
        (stockByItemByLocation[row.item_id][row.location_id] || 0) + Number(row.qty);
    }

    if (includePrice) {
      for (const row of priceRows) priceByItem[row.item_id] = Number(row.price);
    }
  }

  const byId = new Map(
    items.map((i) => [
      i.id,
      {
        id: i.id,
        parent_id: i.parent_id,
        location_id: i.location_id,
        kind: i.kind,
        name: i.name,
        unit: i.unit,
        // Stored, not inferred: a node explicitly created as a category
        // stays a category even while empty (see rollup() below).
        storedIsLeaf: i.is_leaf,
        children: [],
        // leaf-only fields, filled below; parents get computed rollups
        qtyByLocation: {},
        price: includePrice ? priceByItem[i.id] ?? null : undefined,
      },
    ])
  );

  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Post-order rollup: a parent's qty per location = sum of children's.
  // Leaves get their qty straight from `stock`.
  //
  // Leaf-vs-category is decided by the stored `is_leaf` flag, not by
  // whether the node currently has children — an empty category (just
  // created, no children yet) must still render as a category. A node
  // with actual children is always treated as a category regardless of
  // its stored flag, as a defensive fallback.
  function rollup(node) {
    const isLeaf = node.children.length === 0 && node.storedIsLeaf !== false;
    delete node.storedIsLeaf;
    if (isLeaf) {
      node.qtyByLocation = stockByItemByLocation[node.id] || {};
      node.isLeaf = true;
      if (includePrice) node.value = {};
      for (const [locId, qty] of Object.entries(node.qtyByLocation)) {
        if (includePrice && node.price != null) node.value[locId] = qty * node.price;
      }
      return;
    }
    node.isLeaf = false;
    const totals = {};
    const values = {};
    for (const child of node.children) {
      rollup(child);
      for (const [locId, qty] of Object.entries(child.qtyByLocation)) {
        totals[locId] = (totals[locId] || 0) + qty;
      }
      if (includePrice) {
        for (const [locId, val] of Object.entries(child.value || {})) {
          values[locId] = (values[locId] || 0) + val;
        }
      }
    }
    node.qtyByLocation = totals;
    if (includePrice) node.value = values;
  }
  for (const root of roots) rollup(root);

  return roots;
}

// GET /api/items?kind=material|consumable&location=<id>&peek=1
// Operators: their own location's tree only, quantities, no price. With
// `?peek=1`, they instead get the *other* location's tree read-only (still
// no price) — the frontend must not offer any write action against a
// peeked tree.
// Admin: any location via ?location=, or omit for the global (both-tree) view with price.
router.get('/', async (req, res, next) => {
  try {
    const { kind } = req.query;
    const isAdmin = req.user.role === 'admin';

    let locationId = resolveLocationId(req);
    if (!isAdmin) {
      const { data: locations } = await supabaseAdmin.schema('inventory').from('locations').select('id').eq('is_active', true);
      const peekLocationId = resolvePeekLocationId(req, locations);
      if (peekLocationId) locationId = peekLocationId;
    }

    if (!isAdmin && !locationId) {
      return res.status(403).json({ error: 'No location assigned to this account' });
    }

    const locationIds = locationId ? [locationId] : null; // null = all locations (admin overview)
    const tree = await buildTree({ kind: kind || null, locationIds, includePrice: isAdmin });

    res.json({ items: tree });
  } catch (err) {
    next(err);
  }
});

// POST /api/items — admin only: create a category or leaf item.
// body: { name, kind, unit, parent_id, location_id }
// A sub-item inherits its parent's location_id (a tree can't cross
// locations). A top-level category (no parent_id) must say which
// location's tree it belongs to.
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { name, kind, unit, parent_id } = req.body;
    let { location_id } = req.body;
    if (!name || !kind) {
      return res.status(400).json({ error: 'name and kind are required' });
    }
    if (!['material', 'consumable'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be material or consumable' });
    }

    // Leaf-vs-category is chosen at creation, not inferred later. A
    // top-level node is always a category (it's created via "+ Top-level
    // category"). A sub-item defaults to a leaf unless the caller says
    // it's meant to hold further children (is_leaf: false).
    let is_leaf;

    if (parent_id) {
      const { data: parent, error: parentError } = await supabaseAdmin
        .schema('inventory')
        .from('items')
        .select('location_id, is_leaf')
        .eq('id', parent_id)
        .single();
      if (parentError || !parent) return res.status(400).json({ error: 'parent item not found' });
      if (parent.is_leaf) {
        return res.status(400).json({ error: 'cannot add a sub-item under a leaf item — mark the parent as a category first' });
      }
      location_id = parent.location_id;
      is_leaf = req.body.is_leaf !== undefined ? !!req.body.is_leaf : true;
    } else if (!location_id) {
      return res.status(400).json({ error: 'location_id is required for a top-level category' });
    } else {
      is_leaf = false;
    }

    const { data, error } = await supabaseAdmin
      .schema('inventory')
      .from('items')
      .insert({
        name,
        kind,
        unit: unit || 'pcs',
        parent_id: parent_id || null,
        location_id,
        is_leaf,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ item: data });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/items/:id — admin only: rename, reparent, archive, set price.
// body: any of { name, parent_id, is_active, price }
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, parent_id, is_active, price, is_leaf } = req.body;

    const patch = { updated_at: new Date().toISOString() };
    if (name !== undefined) patch.name = name;
    if (parent_id !== undefined) {
      // Mirror POST /api/items: a leaf can't take children, so re-parenting
      // under one would silently orphan that item from the tree view
      // (buildTree's rollup treats any node with real children as a
      // category regardless of its stored flag) while its stock/price rows
      // stay put underneath — a tree-vs-database mismatch. The admin UI's
      // re-parent picker already excludes leaves, but this keeps a direct
      // API call from bypassing that.
      if (parent_id) {
        const { data: parent, error: parentError } = await supabaseAdmin
          .schema('inventory')
          .from('items')
          .select('is_leaf')
          .eq('id', parent_id)
          .single();
        if (parentError || !parent) return res.status(400).json({ error: 'parent item not found' });
        if (parent.is_leaf) {
          return res.status(400).json({ error: 'cannot re-parent under a leaf item — mark it as a category first' });
        }
      }
      patch.parent_id = parent_id;
    }
    if (is_active !== undefined) patch.is_active = is_active;
    // Converting leaf -> category is always safe. Converting category ->
    // leaf is only meaningful if it has no active children (checked here,
    // since the DB's leaf-only-stock trigger only fires on stock/price
    // writes, not on this flag itself).
    if (is_leaf !== undefined) {
      if (is_leaf === true) {
        const { data: children } = await supabaseAdmin
          .schema('inventory')
          .from('items')
          .select('id')
          .eq('parent_id', id)
          .eq('is_active', true)
          .limit(1);
        if (children && children.length) {
          return res.status(400).json({ error: 'cannot mark as a leaf item — it still has sub-items' });
        }
      }
      patch.is_leaf = is_leaf;
    }

    if (Object.keys(patch).length > 1) {
      const { error } = await supabaseAdmin
        .schema('inventory')
        .from('items')
        .update(patch)
        .eq('id', id);
      if (error) return res.status(400).json({ error: error.message });
    }

    if (price !== undefined) {
      const { error: priceError } = await supabaseAdmin
        .schema('inventory')
        .from('item_prices')
        .upsert(
          { item_id: id, price, updated_by: req.user.id, updated_at: new Date().toISOString() },
          { onConflict: 'item_id' }
        );
      if (priceError) return res.status(400).json({ error: priceError.message });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, buildTree };
