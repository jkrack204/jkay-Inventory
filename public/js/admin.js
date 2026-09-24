// Admin app — homepage (two location tiles + dark "Total stock" bar +
// "Needs attention" grouped by location > category), per-location drill-in
// (4 summary cards + priced/valued tree + activity), Inventory Books,
// Prices (universal price editor, grouped by location > category), Item
// trees (per-location tree editor with an inline "…" action panel), and
// the DC document view. Single-page, hash-routed, no build step.
//
// Data model: each location owns its own item tree (items.location_id).
// Admin screens loop over BOTH locations' trees separately rather than
// showing one shared tree — see ADMIN_MOCKUP_REFERENCE.md.

(function () {
  const state = {
    user: null,
    locations: [],
    view: 'home',
    param: null,
    kind: 'material',
    expanded: new Set(),
    search: '',
    pricesSearch: '',
    openActionId: null,
  };

  const root = document.getElementById('app');

  async function boot() {
    const session = await window.JKAuth.requireSession();
    if (!session) return;
    try {
      const [{ user }, { locations }] = await Promise.all([window.JKApi.me(), window.JKApi.locations()]);
      if (user.role !== 'admin') { window.location.href = '/'; return; }
      state.user = user;
      state.locations = locations;
    } catch (err) {
      root.innerHTML = `<div class="empty-state">Could not load account — ${esc(err.message)}</div>`;
      return;
    }
    window.addEventListener('hashchange', route);
    route();
  }

  function route() {
    const hash = window.location.hash.replace('#', '');
    const [view, param] = hash.split('/');
    state.view = view || 'home';
    state.param = param || null;
    state.openActionId = null;
    render();
  }

  async function render() {
    root.innerHTML = `
      <header class="topbar">
        ${window.JKUi.logoMarkHtml()}
        <div class="divider"></div>
        <div class="context"><div class="eyebrow">Admin</div><div class="title" id="ctx-title">Both locations</div></div>
        <div class="spacer"></div>
        <div class="nav-actions">
          <button class="btn" data-nav="books">Inventory Books</button>
          <button class="btn" data-nav="prices">Prices</button>
          <button class="btn" data-nav="trees">Item trees</button>
          <button class="btn-gear" id="btn-settings" title="Settings">&#9881;</button>
          <button class="btn icon" id="btn-signout" title="Sign out">&#8594;</button>
        </div>
      </header>
      <div class="page" id="view-root"></div>
    `;
    root.querySelectorAll('[data-nav]').forEach((b) => { b.onclick = () => { window.location.hash = b.dataset.nav; }; });
    root.querySelector('#btn-signout').onclick = () => window.JKAuth.signOut();
    root.querySelector('#btn-settings').onclick = () => window.JKUi.openSettingsModal({});

    const v = document.getElementById('view-root');
    if (state.view === 'home') return renderHome(v);
    if (state.view === 'location') return renderLocation(v, state.param);
    if (state.view === 'books') return renderBooks(v);
    if (state.view === 'prices') return renderPrices(v);
    if (state.view === 'trees') return renderTrees(v);
  }

  // ---------------------------------------------------------------
  // Shared tree helpers
  // ---------------------------------------------------------------

  // Flattens a (possibly multi-root) tree into id -> metadata, including a
  // breadcrumb `path` of ancestor names (not including the node's own
  // name) and the top-level category id/name/kind it lives under. Used by
  // Home to enrich the flat out-of-stock/low-stock rows with a category +
  // breadcrumb, and to compute per-location tile stats.
  function flattenIndex(tree) {
    const map = new Map();
    function walk(node, path, topId, topName) {
      const isTop = path.length === 0;
      const myTopId = isTop ? node.id : topId;
      const myTopName = isTop ? node.name : topName;
      const qty = Object.values(node.qtyByLocation || {}).reduce((s, v) => s + Number(v), 0);
      map.set(node.id, {
        id: node.id,
        name: node.name,
        unit: node.unit,
        kind: node.kind,
        isLeaf: node.isLeaf,
        qty,
        price: node.price ?? null,
        path: path.slice(),
        topId: myTopId,
        topName: myTopName,
      });
      (node.children || []).forEach((c) => walk(c, path.concat(node.name), myTopId, myTopName));
    }
    (tree || []).forEach((n) => walk(n, [], null, null));
    return map;
  }

  function connectorsHtml(depth, isLast, parentChain) {
    if (depth === 0) return '';
    const defs = [{ vlineOff: isLast, corner: true }].concat(parentChain.map((wasLast) => ({ vlineOff: wasLast, corner: false })));
    return defs.map((c) => `
      <span class="connector">
        <span class="vline${c.vlineOff ? ' off' : ''}"></span>
        <span class="corner${c.corner ? '' : ' off'}"></span>
      </span>
    `).join('');
  }

  function matches(node, q) {
    if (!q) return true;
    if (node.name.toLowerCase().includes(q.toLowerCase())) return true;
    return (node.children || []).some((c) => matches(c, q));
  }
  function expandForSearch(node, q) {
    if (!node.children || !node.children.length) return;
    if (node.children.some((c) => matches(c, q))) {
      state.expanded.add(node.id);
      node.children.forEach((c) => expandForSearch(c, q));
    }
  }

  function plainNum(n) {
    return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }
  function sumQty(qtyByLocation) {
    return Object.values(qtyByLocation || {}).reduce((s, v) => s + Number(v), 0);
  }

  // ---------------------------------------------------------------
  // Home
  // ---------------------------------------------------------------
  async function renderHome(el) {
    el.innerHTML = `
      <div class="tile-row" id="tiles"><div class="loading-state">Loading…</div></div>
      <div class="total-bar" id="total-bar"></div>
      <div class="card" id="attention-card">
        <div class="section-head" style="padding:18px 22px 8px;"><h2>Needs attention</h2><div class="meta" id="attn-meta"></div></div>
        <div id="attn-list"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    const [{ per_location, overall }, treesByLoc] = await Promise.all([
      window.JKApi.valuation(),
      Promise.all(state.locations.map((l) => window.JKApi.items({ location: l.id }))),
    ]);

    const indexByLoc = {};
    state.locations.forEach((l, i) => { indexByLoc[l.id] = flattenIndex(treesByLoc[i].items); });

    const tilesEl = el.querySelector('#tiles');
    tilesEl.innerHTML = state.locations.map((loc) => {
      const v = per_location.find((p) => p.location_id === loc.id) || { total_qty: 0, total_value: 0 };
      const idx = indexByLoc[loc.id];
      let holding = 0, zero = 0;
      idx.forEach((n) => { if (n.isLeaf) { if (n.qty > 0) holding++; else zero++; } });
      return `
        <div class="tile" data-loc="${loc.id}">
          <div style="display:flex; align-items:flex-start;">
            <div style="flex:1;">
              <div class="eyebrow">Location</div>
              <div class="tile-title">${esc(loc.name)}</div>
            </div>
            <div class="tile-arrow">&#8594;</div>
          </div>
          <div class="tile-stats">
            <div><span class="stat-value">${JKFmt.money(v.total_value)}</span><span class="stat-label">stock value</span></div>
            <div><span class="stat-value">${JKFmt.qty(v.total_qty)}</span><span class="stat-label">total quantity</span></div>
            <div><span class="stat-value">${JKFmt.qty(holding)}</span><span class="stat-label">items holding stock</span></div>
            <div><span class="stat-value bad">${JKFmt.qty(zero)}</span><span class="stat-label">at zero</span></div>
          </div>
        </div>
      `;
    }).join('');
    tilesEl.querySelectorAll('.tile').forEach((t) => { t.onclick = () => { window.location.hash = `location/${t.dataset.loc}`; }; });

    el.querySelector('#total-bar').innerHTML = `
      <div class="label">Total stock</div>
      <div class="spacer"></div>
      <div class="stats">
        <div><div class="stat-value">${JKFmt.money(overall.total_value)}</div><div class="stat-label">stock value</div></div>
        <div><div class="stat-value">${JKFmt.qty(overall.total_qty)}</div><div class="stat-label">total quantity</div></div>
      </div>
    `;

    // Needs attention: out-of-stock + low-stock, grouped by location > top-level category.
    const [outByLoc, lowLists] = await Promise.all([
      window.JKApi.outOfStock(),
      Promise.all(state.locations.map((l) => window.JKApi.lowStock({ location: l.id }))),
    ]);

    const groups = [];
    function groupFor(locId, locName, top) {
      let g = groups.find((x) => x.locId === locId && x.topId === top.topId);
      if (!g) { g = { locId, locName, topId: top.topId, topName: top.topName, kind: top.kind, rows: [] }; groups.push(g); }
      return g;
    }

    outByLoc.out_of_stock.forEach((r) => {
      const idx = indexByLoc[r.location_id];
      const meta = idx && idx.get(r.item_id);
      const loc = state.locations.find((l) => l.id === r.location_id);
      const top = meta ? { topId: meta.topId, topName: meta.topName, kind: meta.kind } : { topId: `unknown-${r.location_id}`, topName: 'Uncategorised', kind: r.kind };
      groupFor(r.location_id, (loc && loc.name) || r.location_name, top).rows.push({
        status: 'zero', item_id: r.item_id, name: r.item_name, unit: r.unit,
        crumb: meta ? meta.path.join(' › ') : '', price: meta ? meta.price : null,
      });
    });

    state.locations.forEach((loc, i) => {
      const idx = indexByLoc[loc.id];
      lowLists[i].low_stock.forEach((r) => {
        const meta = idx.get(r.item_id);
        const top = meta ? { topId: meta.topId, topName: meta.topName, kind: meta.kind } : { topId: `unknown-${loc.id}`, topName: 'Uncategorised', kind: null };
        groupFor(loc.id, loc.name, top).rows.push({
          status: 'low', item_id: r.item_id, name: r.item_name, unit: r.unit,
          crumb: meta ? meta.path.join(' › ') : '', price: meta ? meta.price : null, qty: r.qty,
        });
      });
    });

    const totalZero = outByLoc.out_of_stock.length;
    const totalLow = lowLists.reduce((s, l) => s + l.low_stock.length, 0);
    el.querySelector('#attn-meta').textContent = `${totalZero} at zero · ${totalLow} below the alert · ${groups.length} categor${groups.length === 1 ? 'y' : 'ies'}`;

    const listEl = el.querySelector('#attn-list');
    if (!groups.length) { listEl.innerHTML = `<div class="empty-state">Nothing needs attention right now.</div>`; return; }

    listEl.innerHTML = groups.map((g) => `
      <div class="attn-group-head">
        <span class="loc-pill ${g.locName === 'Fabrication' ? 'fab' : 'finished'}">${esc(g.locName)}</span>
        <span class="cat">${esc(g.topName)}</span>
        <span class="kind">${g.kind === 'consumable' ? 'Consumables' : 'Materials'}</span>
        <span class="spacer"></span>
        <span class="count">${g.rows.length} item${g.rows.length === 1 ? '' : 's'}</span>
      </div>
      ${g.rows.map((r) => `
        <div class="attn-row">
          <span class="status-dot${r.status === 'zero' ? ' bad' : ''}"></span>
          <div><div class="name">${esc(r.name)}</div><div class="sub">${r.crumb ? esc(r.crumb) + ' · ' : ''}${r.status === 'zero' ? 'nothing on hand' : `${JKFmt.qty(r.qty)} ${esc(r.unit)} left`}</div></div>
          <div class="spacer"></div>
          <span class="${r.status === 'zero' ? 'status-pill-out' : 'status-pill-low'}">${r.status === 'zero' ? 'OUT' : 'LOW'}</span>
          <span class="qty ${r.status === 'zero' ? 'bad' : 'normal'}">${r.status === 'zero' ? '0' : JKFmt.qty(r.qty)} ${esc(r.unit)}</span>
          <span class="price">${r.price != null ? `${JKFmt.money(r.price)} / ${esc(r.unit)}` : '—'}</span>
        </div>
      `).join('')}
    `).join('');
  }

  // ---------------------------------------------------------------
  // Location drill-in (4 summary cards + priced/valued tree + activity)
  // ---------------------------------------------------------------
  async function renderLocation(el, locId) {
    const loc = state.locations.find((l) => l.id === locId);
    if (!loc) { el.innerHTML = `<div class="empty-state">Location not found.</div>`; return; }
    document.getElementById('ctx-title').textContent = loc.name;

    el.innerHTML = `
      <div class="summary-cards" id="summary-cards"><div class="loading-state">Loading…</div></div>
      <div class="tree-toolbar">
        <div class="tabs">
          <button class="tab ${state.kind === 'material' ? 'active' : ''}" data-kind="material">Materials</button>
          <button class="tab ${state.kind === 'consumable' ? 'active' : ''}" data-kind="consumable">Consumables</button>
        </div>
        <input class="search-input" id="search" placeholder="Search items" />
      </div>
      <div class="tree-table" style="margin-bottom:26px;">
        <div class="tree-head">
          <div class="col-name">Material</div>
          <div class="col-qty" style="flex:0 0 124px;">On hand</div>
          <div class="col-price" style="flex:0 0 112px; padding-left:10px;">Price &#8377;</div>
          <div class="col-value" style="flex:0 0 140px; padding-left:10px;">Value &#8377;</div>
        </div>
        <div id="tree-body"><div class="loading-state">Loading…</div></div>
      </div>
      <div class="section-head"><h2>Activity</h2></div>
      <div class="tree-table" id="dc-list"><div class="loading-state">Loading…</div></div>
    `;
    el.querySelectorAll('.tab').forEach((b) => { b.onclick = () => { state.kind = b.dataset.kind; renderLocation(el, locId); }; });
    el.querySelector('#search').oninput = debounce((e) => { state.search = e.target.value; loadAndRenderTree(locId); }, 150);

    const [{ items: fullTree }, { dcs }] = await Promise.all([
      window.JKApi.items({ location: locId }),
      window.JKApi.dcs({ location: locId }),
    ]);

    const idx = flattenIndex(fullTree);
    let matValue = 0, consValue = 0, zero = 0, unpriced = 0;
    idx.forEach((n) => {
      if (!n.isLeaf) return;
      const value = n.price != null ? n.price * n.qty : 0;
      if (n.kind === 'consumable') consValue += value; else matValue += value;
      if (n.qty <= 0) zero++;
      if (n.price == null && n.qty > 0) unpriced++;
    });
    const inCount = dcs.filter((d) => d.direction === 'in').length;
    const outCount = dcs.filter((d) => d.direction === 'out').length;

    el.querySelector('#summary-cards').innerHTML = `
      <div class="summary-card">
        <div class="label">Stock value here</div>
        <div class="value">${JKFmt.money(matValue + consValue)}</div>
        <div class="sub">materials ${JKFmt.money(matValue)} · consumables ${JKFmt.money(consValue)}</div>
      </div>
      <div class="summary-card">
        <div class="label">DCs logged</div>
        <div class="value">${dcs.length}</div>
        <div class="sub">${inCount} in · ${outCount} out</div>
      </div>
      <div class="summary-card">
        <div class="label">Items at zero</div>
        <div class="value bad">${zero}</div>
        <div class="sub bad">nothing on hand here</div>
      </div>
      <div class="summary-card">
        <div class="label">Unpriced with stock</div>
        <div class="value ${unpriced > 0 ? 'bad' : 'good'}">${unpriced}</div>
        <div class="sub ${unpriced > 0 ? '' : 'good'}">${unpriced > 0 ? `${unpriced} item${unpriced === 1 ? '' : 's'} missing a rate` : 'every stocked item is priced'}</div>
      </div>
    `;

    await loadAndRenderTree(locId);

    const dcList = el.querySelector('#dc-list');
    dcList.innerHTML = dcs.length ? dcs.map((dc) => `
      <div class="dc-row" data-id="${dc.id}">
        <div class="dc-dir ${dc.direction}">${dc.direction === 'in' ? '↓' : '↑'}</div>
        <div class="main">
          <div class="dc-no">${esc(dc.dc_no)} &middot; ${esc(dc.party)}</div>
          <div class="dc-sub">${dc.lines.map((l) => `${JKFmt.qty(l.qty)} ${esc(l.unit)} ${esc(l.item_name)}`).join(', ')}</div>
        </div>
        <div class="dc-value">${JKFmt.money(dc.total_value)}</div>
      </div>
    `).join('') : `<div class="empty-state">No activity yet.</div>`;
    dcList.querySelectorAll('.dc-row').forEach((row) => { row.onclick = () => openDcDocument(row.dataset.id); });
  }

  let currentTree = [];
  async function loadAndRenderTree(locId) {
    const { items } = await window.JKApi.items({ kind: state.kind, location: locId });
    currentTree = items;
    renderAdminTree(document.getElementById('tree-body'), locId);
  }

  function renderAdminTree(bodyEl, locId) {
    if (!bodyEl) return;
    const q = state.search.trim();
    const roots = currentTree.filter((n) => matches(n, q));
    if (!roots.length) { bodyEl.innerHTML = `<div class="empty-state">No items found.</div>`; return; }
    if (q) roots.forEach((n) => expandForSearch(n, q));
    const rowsHtml = [];
    roots.forEach((n, i) => renderAdminNode(n, locId, [], i === roots.length - 1, rowsHtml));
    bodyEl.innerHTML = rowsHtml.join('');
    bodyEl.querySelectorAll('.toggle').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
        renderAdminTree(bodyEl, locId);
      };
    });
  }

  // Location drill-in tree: same connector-line row shape as the location
  // desk, plus per-leaf price (plain number, no ₹) and rolled-up value
  // columns. Leaf `.item-sub` stays empty — unit only appears next to qty.
  function renderAdminNode(node, locId, parentChain, isLast, out, depth) {
    depth = depth || 0;
    const qty = Number(node.qtyByLocation?.[locId] || 0);
    const value = Number(node.value?.[locId] || 0);
    const isLeaf = node.isLeaf;
    const low = isLeaf && qty <= 0;
    const connectors = connectorsHtml(depth, isLast, parentChain);

    if (isLeaf) {
      out.push(`
        <div class="tree-row leaf${low ? ' low' : ''}">
          <div class="row-main">
            ${connectors}
            <span class="disclosure"><span class="status-dot${low ? ' bad' : ''}"></span></span>
            <span class="names">
              <span class="item-name">${esc(node.name)}</span>
              <span class="item-sub"></span>
            </span>
          </div>
          <div class="col-qty" style="flex:0 0 124px;"><span class="qty-num">${JKFmt.qty(qty)}</span><span class="unit"> ${esc(node.unit)}</span></div>
          <div class="col-price" style="flex:0 0 112px; padding-left:10px; font-size:15.5px; color:var(--ink-4);">${node.price != null ? plainNum(node.price) : '—'}</div>
          <div class="col-value" style="flex:0 0 140px; padding-left:10px; font-size:16.5px; font-weight:600; color:var(--ink);">${JKFmt.money(value)}</div>
        </div>
      `);
      return;
    }

    const expanded = state.expanded.has(node.id);
    const isTop = depth === 0;
    out.push(`
      <div class="tree-row parent${isTop ? ' top-parent' : ''}">
        <div class="row-main">
          ${connectors}
          <span class="disclosure"><button class="toggle${expanded ? ' open' : ''}" data-id="${node.id}">&#9654;</button></span>
          <span class="names">
            <span class="item-name">${esc(node.name)}</span>
            <span class="item-sub">${node.children.length} item${node.children.length === 1 ? '' : 's'} below &middot; rolled up</span>
          </span>
        </div>
        <div class="col-qty" style="flex:0 0 124px;"><span class="qty-num">${JKFmt.qty(qty)}</span><span class="unit"> ${esc(node.unit)}</span></div>
        <div class="col-price" style="flex:0 0 112px; padding-left:10px;"></div>
        <div class="col-value" style="flex:0 0 140px; padding-left:10px; font-size:16.5px; font-weight:600; color:var(--ink);">${JKFmt.money(value)}</div>
      </div>
    `);
    if (expanded) {
      const childChain = depth === 0 ? [] : [isLast].concat(parentChain);
      node.children.forEach((c, i) => renderAdminNode(c, locId, childChain, i === node.children.length - 1, out, depth + 1));
    }
  }

  // ---------------------------------------------------------------
  // Inventory Books (search across every item at both locations)
  // ---------------------------------------------------------------
  async function renderBooks(el) {
    document.getElementById('ctx-title').textContent = 'Inventory Books';
    el.innerHTML = `
      <div class="section-head">
        <select id="book-loc"></select>
        <select id="book-item" style="min-width:260px;"><option>Loading…</option></select>
      </div>
      <div id="book-content"><div class="loading-state">Choose a location and an item.</div></div>
    `;
    const locSel = el.querySelector('#book-loc');
    locSel.innerHTML = state.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');

    async function loadItemsFor(locId) {
      const [{ items: mats }, { items: cons }] = await Promise.all([
        window.JKApi.items({ kind: 'material', location: locId }),
        window.JKApi.items({ kind: 'consumable', location: locId }),
      ]);
      const leaves = [];
      (function collect(nodes) { nodes.forEach((n) => { if (n.isLeaf) leaves.push(n); else collect(n.children); }); })([...mats, ...cons]);
      return leaves;
    }

    async function loadBook(locId, itemId, leaves) {
      const content = el.querySelector('#book-content');
      if (!itemId) { content.innerHTML = `<div class="empty-state">No items.</div>`; return; }
      content.innerHTML = `<div class="loading-state">Loading…</div>`;
      const book = await window.JKApi.inventoryBooks({ item_id: itemId, location: locId });
      const item = leaves.find((n) => n.id === itemId);
      const rows = [`<div class="tree-row parent"><div class="col-name">Opening balance</div><div class="col-qty">${JKFmt.qty(book.opening_balance)} ${esc(item?.unit || '')}</div><div class="col-price"></div><div class="col-value"></div></div>`];
      book.entries.forEach((e) => {
        rows.push(`
          <div class="dc-row">
            <div class="dc-dir ${e.direction}">${e.direction === 'in' ? '↓' : '↑'}</div>
            <div class="main"><div class="dc-no">${esc(e.dc_no)} &middot; ${esc(e.party)}</div>
              <div class="dc-sub">${e.direction === 'in' ? '+' : '-'}${JKFmt.qty(e.qty)} ${esc(item?.unit || '')} &middot; balance ${JKFmt.qty(e.balance)}</div></div>
            <div class="dc-value">${JKFmt.money(e.value)}</div>
          </div>
        `);
      });
      rows.push(`<div class="tree-row parent"><div class="col-name">Closing balance</div><div class="col-qty">${JKFmt.qty(book.closing_balance)} ${esc(item?.unit || '')}</div><div class="col-price"></div><div class="col-value"></div></div>`);
      content.innerHTML = `<div class="tree-table">${rows.join('')}</div>`;
    }

    async function refreshItems() {
      const leaves = await loadItemsFor(locSel.value);
      const itemSel = el.querySelector('#book-item');
      itemSel.innerHTML = leaves.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join('');
      itemSel.onchange = () => loadBook(locSel.value, itemSel.value, leaves);
      if (leaves.length) loadBook(locSel.value, leaves[0].id, leaves);
    }
    locSel.onchange = refreshItems;
    await refreshItems();
  }

  // ---------------------------------------------------------------
  // Prices editor — one universal price per item, grouped by location >
  // top-level category. Not kind-tabbed: materials and consumables appear
  // together, grouped by category.
  // ---------------------------------------------------------------
  let priceData = [];
  let priceNodeById = new Map();

  async function renderPrices(el) {
    document.getElementById('ctx-title').textContent = 'Prices';
    el.innerHTML = `
      <div class="price-intro">
        <div>
          <div class="heading">One universal price per item</div>
          <div class="sub">Rates set here value every DC at both locations — past and future. Nothing is priced per challan.</div>
        </div>
        <div class="search-pill">
          <span class="glyph">⌕</span>
          <input id="price-search" placeholder="Search any item" />
        </div>
      </div>
      <div id="price-sections"><div class="loading-state">Loading…</div></div>
    `;
    el.querySelector('#price-search').oninput = debounce((e) => { state.pricesSearch = e.target.value; renderPriceSections(); }, 150);

    const treesByLoc = await Promise.all(state.locations.map((l) => window.JKApi.items({ location: l.id })));
    priceData = state.locations.map((l, i) => ({ loc: l, tree: treesByLoc[i].items }));
    renderPriceSections();
  }

  function renderPriceSections() {
    const wrap = document.getElementById('price-sections');
    if (!wrap) return;
    const q = (state.pricesSearch || '').trim().toLowerCase();
    priceNodeById = new Map();

    const sectionsHtml = priceData.map(({ loc, tree }) => {
      const cats = [];
      let priceableCount = 0, unpricedCount = 0, sectionValue = 0;

      tree.forEach((top) => {
        const leaves = [];
        (function collect(node, path) {
          if (node.isLeaf) { leaves.push({ node, path }); return; }
          (node.children || []).forEach((c) => collect(c, path.concat(node.name)));
        })(top, []);

        leaves.forEach(({ node }) => {
          priceableCount++;
          const qty = sumQty(node.qtyByLocation);
          if (node.price == null) unpricedCount++;
          else sectionValue += node.price * qty;
          priceNodeById.set(node.id, node);
        });

        const filtered = q ? leaves.filter(({ node }) => node.name.toLowerCase().includes(q)) : leaves;
        if (filtered.length) cats.push({ name: top.name, kind: top.kind, leaves: filtered });
      });

      if (q && !cats.length) return '';

      return `
        <section class="price-loc-section">
          <div class="price-loc-head">
            <span class="loc-dot ${loc.name === 'Fabrication' ? 'fab' : 'finished'}"></span>
            <span class="loc-name">${esc(loc.name)}</span>
            <span class="loc-meta">${priceableCount} priceable item${priceableCount === 1 ? '' : 's'} · ${unpricedCount} without a rate</span>
            <span class="spacer"></span>
            <div style="text-align:right;">
              <div class="loc-value">${JKFmt.money(sectionValue)}</div>
              <div class="loc-value-sub">stock value at these rates</div>
            </div>
          </div>
          ${cats.map((cat) => `
            <div class="price-cat-head">
              <div class="name">${esc(cat.name)}</div>
              <div class="meta">${cat.kind === 'consumable' ? 'Consumables' : 'Materials'} &middot; ${cat.leaves.length} item${cat.leaves.length === 1 ? '' : 's'}</div>
            </div>
            ${cat.leaves.map(({ node, path }) => {
              const qty = sumQty(node.qtyByLocation);
              const value = node.price != null ? node.price * qty : 0;
              return `
                <div class="price-item-row">
                  <div class="p-left">
                    <div class="p-name">${esc(node.name)}</div>
                    <div class="p-crumb">${esc(path.join(' › '))}</div>
                  </div>
                  <div class="p-mid">
                    <span class="p-rupee">&#8377;</span>
                    <input type="number" min="0" step="any" class="p-input" data-id="${node.id}" value="${node.price ?? ''}" placeholder="set rate" />
                    <span class="p-unit">per ${esc(node.unit)}</span>
                  </div>
                  <div class="p-right">
                    <div class="p-value">${JKFmt.money(value)}</div>
                    <div class="p-onhand">${JKFmt.qty(qty)} ${esc(node.unit)} on hand</div>
                  </div>
                </div>
              `;
            }).join('')}
          `).join('')}
        </section>
      `;
    }).join('');

    wrap.innerHTML = sectionsHtml || `<div class="empty-state">No items found.</div>`;

    wrap.querySelectorAll('.p-input').forEach((input) => {
      input.onchange = async () => {
        const id = input.dataset.id;
        const raw = input.value;
        const val = raw === '' ? null : Number(raw);
        try {
          await window.JKApi.updateItem(id, { price: val });
          const node = priceNodeById.get(id);
          if (node) node.price = val;
          JKToast.good('Price saved.');
          renderPriceSections();
        } catch (err) {
          JKToast.error(err.message);
        }
      };
    });
  }

  // ---------------------------------------------------------------
  // Item trees editor — per-location sections, kind-tabbed, with an
  // inline "…" action panel (rename / change price / low-stock alert /
  // re-parent / archive) instead of flat action buttons.
  // ---------------------------------------------------------------
  let treesData = [];

  async function renderTrees(el) {
    document.getElementById('ctx-title').textContent = 'Item trees';
    el.innerHTML = `
      <div class="section-head">
        <div class="tabs">
          <button class="tab ${state.kind === 'material' ? 'active' : ''}" data-kind="material">Materials</button>
          <button class="tab ${state.kind === 'consumable' ? 'active' : ''}" data-kind="consumable">Consumables</button>
        </div>
      </div>
      <div id="trees-sections"><div class="loading-state">Loading…</div></div>
    `;
    el.querySelectorAll('.tab').forEach((b) => { b.onclick = () => { state.kind = b.dataset.kind; state.openActionId = null; renderTrees(el); }; });

    const treesByLoc = await Promise.all(state.locations.map((l) => window.JKApi.items({ kind: state.kind, location: l.id })));
    treesData = state.locations.map((l, i) => ({ loc: l, tree: treesByLoc[i].items }));
    renderTreesSections();
  }

  function renderTreesSections() {
    const wrap = document.getElementById('trees-sections');
    if (!wrap) return;

    wrap.innerHTML = treesData.map(({ loc, tree }) => {
      let leafCount = 0, catCount = 0;
      (function count(nodes) { nodes.forEach((n) => { if (n.isLeaf) leafCount++; else { catCount++; count(n.children); } }); })(tree);
      const rowsHtml = [];
      tree.forEach((n, i) => renderTreesNode(n, loc.id, [], i === tree.length - 1, rowsHtml));
      const kindLabel = state.kind === 'consumable' ? 'consumable' : 'material';
      return `
        <div class="trees-loc-section">
          <div class="trees-loc-head">
            <div class="left">
              <span class="loc-dot ${loc.name === 'Fabrication' ? 'fab' : 'finished'}"></span>
              <span class="loc-name">${esc(loc.name)}</span>
              <span class="loc-meta">${leafCount} ${kindLabel}${leafCount === 1 ? '' : 's'} · ${catCount} categor${catCount === 1 ? 'y' : 'ies'}</span>
            </div>
            <button class="btn-add-cat" data-loc="${loc.id}">+ Top-level category</button>
          </div>
          <div class="tree-table">
            <div class="tree-head">
              <div class="col-name">Item</div>
              <div class="col-qty" style="flex:0 0 124px;">On hand</div>
              <div class="col-price" style="flex:0 0 112px; padding-left:10px;">Price &#8377;</div>
              <div style="flex:0 0 36px;">&nbsp;</div>
            </div>
            <div>${tree.length ? rowsHtml.join('') : '<div class="empty-state">No categories yet — add one above.</div>'}</div>
          </div>
        </div>
      `;
    }).join('');

    wrap.querySelectorAll('.btn-add-cat').forEach((btn) => {
      btn.onclick = () => openItemForm(null, btn.dataset.loc, () => renderTrees(document.getElementById('view-root')));
    });
    wireTreesRows(wrap);
  }

  function renderTreesNode(node, locId, parentChain, isLast, out, depth) {
    depth = depth || 0;
    const connectors = connectorsHtml(depth, isLast, parentChain);
    const isLeaf = node.isLeaf;
    const expanded = state.expanded.has(node.id);
    const isTop = depth === 0;
    const qty = sumQty(node.qtyByLocation);

    out.push(`
      <div class="tree-row ${isLeaf ? 'leaf' : `parent${isTop ? ' top-parent' : ''}`}">
        <div class="row-main">
          ${connectors}
          <span class="disclosure">${isLeaf
            ? `<span class="status-dot${qty <= 0 ? ' bad' : ''}"></span>`
            : `<button class="toggle${expanded ? ' open' : ''}" data-id="${node.id}">&#9654;</button>`}</span>
          <span class="names">
            <span class="item-name">${esc(node.name)}</span>
            <span class="item-sub">${isLeaf ? '' : `${node.children.length} item${node.children.length === 1 ? '' : 's'} below`}</span>
          </span>
        </div>
        <div class="col-qty" style="flex:0 0 124px;"><span class="qty-num">${JKFmt.qty(qty)}</span><span class="unit"> ${esc(node.unit)}</span></div>
        <div class="col-price" style="flex:0 0 112px; padding-left:10px;">${isLeaf && node.price != null ? plainNum(node.price) : ''}</div>
        <div style="flex:0 0 36px; display:flex; justify-content:flex-end;">
          <button class="btn-more" data-act="more" data-id="${node.id}" data-loc="${locId}" title="More actions">&#8230;</button>
        </div>
      </div>
      ${state.openActionId === node.id ? renderActionPanel(node, locId, isLeaf) : ''}
    `);
    if (!isLeaf && expanded) {
      const childChain = depth === 0 ? [] : [isLast].concat(parentChain);
      node.children.forEach((c, i) => renderTreesNode(c, locId, childChain, i === node.children.length - 1, out, depth + 1));
    }
  }

  function renderActionPanel(node, locId, isLeaf) {
    return `
      <div class="item-action-panel">
        ${!isLeaf ? `<button class="btn btn-sm" data-act="add-child" data-id="${node.id}">+ Sub-item</button>` : ''}
        <button class="btn btn-sm" data-act="rename" data-id="${node.id}" data-name="${esc(node.name)}">Rename</button>
        ${isLeaf ? `<button class="btn btn-sm" data-act="price" data-id="${node.id}" data-price="${node.price ?? ''}">Change price</button>` : ''}
        ${isLeaf ? `<button class="btn btn-sm" data-act="threshold" data-id="${node.id}" data-loc="${locId}">Low-stock alert</button>` : ''}
        <button class="btn btn-sm" data-act="reparent" data-id="${node.id}" data-loc="${locId}">Re-parent</button>
        <span style="flex:1 1 auto;"></span>
        <button class="btn btn-sm btn-danger" data-act="archive" data-id="${node.id}">Archive</button>
      </div>
    `;
  }

  function wireTreesRows(wrap) {
    wrap.querySelectorAll('.toggle').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
        renderTreesSections();
      };
    });
    wrap.querySelectorAll('[data-act="more"]').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        state.openActionId = state.openActionId === id ? null : id;
        renderTreesSections();
      };
    });
    wrap.querySelectorAll('[data-act="add-child"]').forEach((btn) => {
      btn.onclick = () => { state.openActionId = null; openItemForm(btn.dataset.id, null, () => renderTrees(document.getElementById('view-root'))); };
    });
    wrap.querySelectorAll('[data-act="rename"]').forEach((btn) => {
      btn.onclick = async () => {
        const name = prompt('Rename to:', btn.dataset.name);
        if (!name || name === btn.dataset.name) return;
        try {
          await window.JKApi.updateItem(btn.dataset.id, { name });
          JKToast.good('Renamed.');
          state.openActionId = null;
          renderTrees(document.getElementById('view-root'));
        } catch (err) { JKToast.error(err.message); }
      };
    });
    wrap.querySelectorAll('[data-act="price"]').forEach((btn) => {
      btn.onclick = async () => {
        const val = prompt('Set price (₹ per unit):', btn.dataset.price || '');
        if (val === null) return;
        const num = Number(val);
        if (!(num >= 0)) { JKToast.error('Enter a valid price.'); return; }
        try {
          await window.JKApi.updateItem(btn.dataset.id, { price: num });
          JKToast.good('Price saved.');
          state.openActionId = null;
          renderTrees(document.getElementById('view-root'));
        } catch (err) { JKToast.error(err.message); }
      };
    });
    wrap.querySelectorAll('[data-act="threshold"]').forEach((btn) => {
      btn.onclick = async () => {
        const val = prompt('Alert when stock is at or below:');
        if (val === null) return;
        const num = Number(val);
        if (!(num >= 0)) { JKToast.error('Enter a valid threshold.'); return; }
        try {
          await window.JKApi.setThreshold(btn.dataset.id, num, { location: btn.dataset.loc });
          JKToast.good('Threshold saved.');
          state.openActionId = null;
          renderTreesSections();
        } catch (err) { JKToast.error(err.message); }
      };
    });
    wrap.querySelectorAll('[data-act="reparent"]').forEach((btn) => {
      btn.onclick = () => openReparentModal(btn.dataset.id, btn.dataset.loc);
    });
    wrap.querySelectorAll('[data-act="archive"]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Archive this item? It will be hidden but its history is kept.')) return;
        try {
          await window.JKApi.updateItem(btn.dataset.id, { is_active: false });
          JKToast.good('Archived.');
          state.openActionId = null;
          renderTrees(document.getElementById('view-root'));
        } catch (err) { JKToast.error(err.message); }
      };
    });
  }

  function openItemForm(parentId, locId, onDone) {
    openModal(parentId ? 'Add sub-item' : 'Add top-level category', `
      <div class="field"><label>Name</label><input id="f-name" /></div>
      <div class="field"><label>Unit</label><input id="f-unit" placeholder="e.g. sheets, pieces, sets, kg" value="pcs" /></div>
      <div class="field error hidden" id="f-error"></div>
    `, [
      { label: 'Cancel', onClick: () => closeModal() },
      {
        label: 'Create', primary: true, onClick: async (btn) => {
          const name = document.getElementById('f-name').value.trim();
          const unit = document.getElementById('f-unit').value.trim() || 'pcs';
          const errorEl = document.getElementById('f-error');
          if (!name) { errorEl.textContent = 'Name is required.'; errorEl.classList.remove('hidden'); return; }
          btn.disabled = true;
          try {
            await window.JKApi.createItem({
              name, unit, kind: state.kind,
              parent_id: parentId || undefined,
              location_id: parentId ? undefined : locId,
            });
            closeModal();
            JKToast.good('Created.');
            onDone();
          } catch (err) {
            errorEl.textContent = err.message; errorEl.classList.remove('hidden'); btn.disabled = false;
          }
        },
      },
    ]);
  }

  // Re-parent: a leaf/category can only move within its own location's
  // tree (a leaf can't cross locations — the DB trigger rejects that
  // anyway), so the select is scoped to that location's own categories.
  function openReparentModal(itemId, locId) {
    const section = treesData.find((t) => t.loc.id === locId);
    const options = [];
    (function walk(nodes, path) {
      (nodes || []).forEach((n) => {
        if (!n.isLeaf) {
          if (n.id !== itemId) options.push({ id: n.id, label: path.concat(n.name).join(' › ') });
          walk(n.children, path.concat(n.name));
        }
      });
    })(section ? section.tree : [], []);

    openModal('Re-parent item', `
      <div class="field">
        <label>Move under</label>
        <select id="f-parent">
          <option value="">— top level —</option>
          ${options.map((o) => `<option value="${o.id}">${esc(o.label)}</option>`).join('')}
        </select>
      </div>
      <div class="field error hidden" id="f-error"></div>
    `, [
      { label: 'Cancel', onClick: () => closeModal() },
      {
        label: 'Move', primary: true, onClick: async (btn) => {
          const newParent = document.getElementById('f-parent').value || null;
          btn.disabled = true;
          try {
            await window.JKApi.updateItem(itemId, { parent_id: newParent });
            closeModal();
            JKToast.good('Moved.');
            state.openActionId = null;
            renderTrees(document.getElementById('view-root'));
          } catch (err) {
            const errorEl = document.getElementById('f-error');
            errorEl.textContent = err.message; errorEl.classList.remove('hidden'); btn.disabled = false;
          }
        },
      },
    ]);
  }

  // ---------------------------------------------------------------
  // DC document view
  // ---------------------------------------------------------------
  async function openDcDocument(dcId) {
    const { dc } = await window.JKApi.dc(dcId);
    const locName = state.locations.find((l) => l.id === dc.location_id)?.name || '';
    openModal(`DC ${dc.dc_no}`, `
      <div class="doc-sheet" style="padding:24px; border:none;">
        <div class="doc-head">
          <div>
            <div style="font-size:20px; font-weight:800;">${esc(dc.dc_no)}</div>
            <div style="color:var(--ink-4); font-size:13px; margin-top:4px;">${dc.direction === 'in' ? 'Input DC' : 'Output DC'} &middot; ${esc(locName)}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); font-weight:600;">Date</div>
            <div style="font-weight:600; margin-top:2px;">${JKFmt.dateTime(dc.created_at)}</div>
          </div>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:20px; margin-bottom:18px;">
          <div><div style="font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); font-weight:600;">Party</div><div style="font-weight:600; margin-top:3px;">${esc(dc.party)}</div></div>
          ${dc.vehicle_no ? `<div><div style="font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); font-weight:600;">Vehicle</div><div style="font-weight:600; margin-top:3px;">${esc(dc.vehicle_no)}</div></div>` : ''}
          ${dc.address ? `<div><div style="font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); font-weight:600;">Address</div><div style="font-weight:600; margin-top:3px;">${esc(dc.address)}</div></div>` : ''}
          ${dc.note ? `<div><div style="font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); font-weight:600;">Note</div><div style="font-weight:600; margin-top:3px;">${esc(dc.note)}</div></div>` : ''}
        </div>
        <table>
          <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Value</th></tr></thead>
          <tbody>
            ${dc.lines.map((l) => `<tr><td>${esc(l.item_name)}</td><td class="num">${JKFmt.qty(l.qty)} ${esc(l.unit)}</td><td class="num">${JKFmt.money(l.price)}</td><td class="num">${JKFmt.money(l.value)}</td></tr>`).join('')}
          </tbody>
        </table>
        <div style="text-align:right; font-weight:800; font-size:16px;">Total: ${JKFmt.money(dc.total_value)}</div>
      </div>
    `, [{ label: 'Close', primary: true, onClick: () => closeModal() }], { wide: true });
  }

  // ---------------------------------------------------------------
  // Modal helper (same pattern as location-desk.js)
  // ---------------------------------------------------------------
  function openModal(title, bodyHtml, buttons, opts) {
    closeModal();
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    scrim.id = 'active-modal';
    scrim.innerHTML = `
      <div class="modal${opts && opts.wide ? ' wide' : ''}">
        <div class="modal-head"><div class="title">${esc(title)}</div><button class="btn btn-ghost icon" id="modal-close">&times;</button></div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-foot">${buttons.map((b, i) => `<button class="btn ${b.primary ? 'btn-primary' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>
      </div>
    `;
    document.body.appendChild(scrim);
    scrim.querySelector('#modal-close').onclick = () => closeModal();
    scrim.addEventListener('click', (e) => { if (e.target === scrim) closeModal(); });
    buttons.forEach((b, i) => { scrim.querySelectorAll('.modal-foot .btn')[i].onclick = (e) => b.onClick(e.target); });
    return scrim;
  }
  function closeModal() { document.getElementById('active-modal')?.remove(); }

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  boot();
})();
