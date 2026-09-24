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
        ${state.view !== 'home' ? `<button class="btn btn-back" id="btn-admin-home">&larr; Admin home</button>` : ''}
        <div class="nav-actions">
          <button class="btn${state.view === 'books' ? ' active' : ''}" data-nav="books">Inventory Books</button>
          <button class="btn${state.view === 'prices' ? ' active' : ''}" data-nav="prices">Prices</button>
          <button class="btn${state.view === 'trees' ? ' active' : ''}" data-nav="trees">Item trees</button>
          <button class="btn${state.view === 'dcs' ? ' active' : ''}" data-nav="dcs">DC Log</button>
          <button class="btn${state.view === 'edit-log' ? ' active' : ''}" data-nav="edit-log">Edit Log</button>
          <button class="btn${state.view === 'users' ? ' active' : ''}" data-nav="users">Users</button>
          <button class="btn-gear" id="btn-settings" title="Settings">&#9881;</button>
          <button class="btn icon" id="btn-signout" title="Sign out">&#8594;</button>
        </div>
      </header>
      <div class="page" id="view-root"></div>
    `;
    root.querySelectorAll('[data-nav]').forEach((b) => { b.onclick = () => { window.location.hash = b.dataset.nav; }; });
    const backBtn = root.querySelector('#btn-admin-home');
    if (backBtn) backBtn.onclick = () => { window.location.hash = 'home'; };
    root.querySelector('#btn-signout').onclick = () => window.JKAuth.signOut();
    root.querySelector('#btn-settings').onclick = () => window.JKUi.openSettingsModal({});

    const v = document.getElementById('view-root');
    if (state.view === 'home') return renderHome(v);
    if (state.view === 'location') return renderLocation(v, state.param);
    if (state.view === 'books') return renderBooks(v);
    if (state.view === 'prices') return renderPrices(v);
    if (state.view === 'trees') return renderTrees(v);
    if (state.view === 'dcs') return renderDcs(v);
    if (state.view === 'edit-log') return renderEditLog(v);
    if (state.view === 'users') return renderUsers(v);
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

    // All four fetch groups fired together up front — none of them actually
    // depend on each other's data, only the rendering below does. Used to
    // be two sequential `await Promise.all(...)` batches (tiles, then
    // attention), which cost a full extra network round-trip on every load
    // of the busiest screen in Admin for no reason.
    const [{ per_location, overall }, treesByLoc, outByLoc, lowLists] = await Promise.all([
      window.JKApi.valuation(),
      Promise.all(state.locations.map((l) => window.JKApi.items({ location: l.id }))),
      window.JKApi.outOfStock(),
      Promise.all(state.locations.map((l) => window.JKApi.lowStock({ location: l.id }))),
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
    // (outByLoc/lowLists were already fetched above, in parallel with tiles.)
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
        <div class="tree-total-row" id="tree-total"></div>
      </div>
      <section class="activity-panel">
        <div class="activity-panel-head">
          <div class="title">Activity at ${esc(loc.name)}</div>
          <div class="meta" id="dc-count"></div>
          <div class="spacer"></div>
          <div class="search-pill sm"><span class="glyph">&#8981;</span><input id="dc-search" placeholder="DC no., item or party" /></div>
          <div class="seg" id="dc-filter">
            <button data-val="all" class="active">All</button>
            <button data-val="in">Input</button>
            <button data-val="out">Output</button>
          </div>
        </div>
        <div class="activity-table-head">
          <div style="flex:0 0 96px;">DC</div>
          <div style="flex:1 1 auto;">Item and party</div>
          <div style="flex:0 0 110px; text-align:right;">Qty</div>
          <div style="flex:0 0 124px; text-align:right; padding-left:10px;">Value &#8377;</div>
          <div style="flex:0 0 104px; text-align:right; padding-left:10px;">When</div>
        </div>
        <div id="dc-list"><div class="loading-state">Loading…</div></div>
      </section>
    `;
    el.querySelectorAll('.tab').forEach((b) => { b.onclick = () => { state.kind = b.dataset.kind; renderLocation(el, locId); }; });
    el.querySelector('#search').oninput = debounce((e) => { state.search = e.target.value; loadAndRenderTree(locId); }, 150);
    let dcSearch = '';
    let dcFilter = 'all';

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

    // Tree total row — mockup-exact: "Total · Materials/Consumables at
    // <Location>" against the value for whichever tab is active.
    const kindLabel = state.kind === 'consumable' ? 'Consumables' : 'Materials';
    el.querySelector('#tree-total').innerHTML = `
      <div class="left">Total &middot; ${esc(kindLabel)} at ${esc(loc.name)}</div>
      <div class="right">${JKFmt.money(state.kind === 'consumable' ? consValue : matValue)}</div>
    `;

    // Activity — mockup-exact: search + All/Input/Output filter, and a
    // DC / Item and party / Qty / Value / When row layout with a small
    // direction badge instead of the desk's simpler list.
    function renderDcRows() {
      const dcListEl = el.querySelector('#dc-list');
      if (!dcListEl) return;
      const q = dcSearch.trim().toLowerCase();
      const rows = dcs.filter((dc) => {
        if (dcFilter !== 'all' && dc.direction !== dcFilter) return false;
        if (!q) return true;
        const hay = [dc.dc_no, dc.party, ...dc.lines.map((l) => l.item_name)].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
      el.querySelector('#dc-count').textContent = `${JKFmt.qty(dcs.length)} at this location`;
      if (!rows.length) { dcListEl.innerHTML = `<div class="empty-state">${dcs.length ? 'No DCs match that search.' : 'No activity yet.'}</div>`; return; }
      dcListEl.innerHTML = rows.map((dc) => {
        const itemsLabel = dc.lines.length ? esc(dc.lines[0].item_name) + (dc.lines.length > 1 ? ` + ${dc.lines.length - 1} more` : '') : '';
        const subBase = dc.direction === 'out'
          ? `out to ${esc(dc.party || '')}${dc.note ? ` &middot; ${esc(dc.note)}` : ''}`
          : `${dc.note ? esc(dc.note) : (dc.party ? esc(dc.party) : '')}`;
        const byName = dc.created_by_name ? `by ${esc(dc.created_by_name)}` : '';
        const sub = [subBase, byName].filter(Boolean).join(' &middot; ') + (dc.edit_count ? ' &middot; <span style="color:var(--accent);">edited</span>' : '');
        const totalQty = dc.lines.reduce((s, l) => s + Number(l.qty), 0);
        const qtyLabel = dc.lines.length === 1 ? `${JKFmt.qty(dc.lines[0].qty)} ${esc(dc.lines[0].unit)}` : `${JKFmt.qty(totalQty)} units`;
        return `
          <a class="activity-row" href="/dc.html?id=${dc.id}" target="_blank" rel="noopener">
            <div class="ar-dc">
              <span class="ar-dir ${dc.direction}">${dc.direction === 'in' ? '&#8595;' : '&#8593;'}</span>
              <span class="ar-no">${esc(dc.dc_no)}</span>
            </div>
            <div class="ar-main">
              <div class="ar-item">${itemsLabel}</div>
              <div class="ar-sub">${sub}</div>
            </div>
            <div class="ar-qty">${qtyLabel}</div>
            <div class="ar-value">${JKFmt.money(dc.total_value)}</div>
            <div class="ar-when">${JKFmt.dateTime(dc.created_at)}</div>
          </a>
        `;
      }).join('');
    }
    renderDcRows();
    el.querySelector('#dc-search').oninput = debounce((e) => { dcSearch = e.target.value; renderDcRows(); }, 150);
    el.querySelectorAll('#dc-filter button').forEach((b) => {
      b.onclick = () => {
        dcFilter = b.dataset.val;
        el.querySelectorAll('#dc-filter button').forEach((x) => x.classList.toggle('active', x === b));
        renderDcRows();
      };
    });
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
  // Inventory Books — a single flat list spanning BOTH locations (not a
  // per-location dropdown), 4 summary cards, and a full-screen ledger
  // overlay per item (rate + stock value instead of the desk's
  // inwards/outwards). Replicated one-to-one from the admin mockup.
  // ---------------------------------------------------------------
  let booksLeaves = [];
  let booksSearch = '';

  async function renderBooks(el) {
    document.getElementById('ctx-title').textContent = 'Inventory books';
    el.innerHTML = `
      <div class="summary-cards" id="books-summary"><div class="loading-state">Loading…</div></div>
      <div class="book-list with-loc" id="books-card">
        <div class="book-card-head">
          <div class="titles">
            <div class="h">Every item</div>
            <div class="sub" id="books-meta">Loading…</div>
          </div>
          <div class="search-pill">
            <span class="glyph">&#8981;</span>
            <input id="books-search" placeholder="Search any item" value="${esc(booksSearch)}" />
          </div>
        </div>
        <div id="books-rows"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    // One call each: the global item tree already spans both locations
    // (admin, no ?location=) and carries price/value; DCs likewise with
    // no location filter returns both locations' challans.
    const [{ items: tree }, { dcs }] = await Promise.all([
      window.JKApi.items({}),
      window.JKApi.dcs({}),
    ]);
    const locById = new Map(state.locations.map((l) => [l.id, l]));
    booksLeaves = flattenLeavesWithPathAdmin(tree).sort((a, b) => a.node.name.localeCompare(b.node.name));

    const moveByItem = {};
    let inwardsValue = 0, inwardsUnits = 0, outwardsValue = 0, outwardsUnits = 0, inCount = 0, outCount = 0;
    dcs.forEach((dc) => {
      if (dc.direction === 'in') inCount++; else outCount++;
      (dc.lines || []).forEach((l) => {
        const m = moveByItem[l.item_id] || (moveByItem[l.item_id] = { in: 0, out: 0, n: 0 });
        m.n += 1;
        if (dc.direction === 'in') { m.in += Number(l.qty); inwardsValue += Number(l.value || 0); inwardsUnits += Number(l.qty); }
        else { m.out += Number(l.qty); outwardsValue += Number(l.value || 0); outwardsUnits += Number(l.qty); }
      });
    });

    const zeroCount = booksLeaves.filter((e) => Number(e.node.qtyByLocation?.[e.node.location_id] || 0) <= 0).length;

    el.querySelector('#books-summary').innerHTML = `
      <div class="summary-card">
        <div class="label">Items on the books</div>
        <div class="value">${JKFmt.qty(booksLeaves.length)}</div>
        <div class="sub${zeroCount ? ' bad' : ''}">${JKFmt.qty(zeroCount)} at zero</div>
      </div>
      <div class="summary-card">
        <div class="label">Challans</div>
        <div class="value">${JKFmt.qty(dcs.length)}</div>
        <div class="sub">${JKFmt.qty(inCount)} in &middot; ${JKFmt.qty(outCount)} out</div>
      </div>
      <div class="summary-card">
        <div class="label">Inwards value</div>
        <div class="value good">${JKFmt.money(inwardsValue)}</div>
        <div class="sub">${JKFmt.qty(inwardsUnits)} units received</div>
      </div>
      <div class="summary-card">
        <div class="label">Outwards value</div>
        <div class="value">${JKFmt.money(outwardsValue)}</div>
        <div class="sub">${JKFmt.qty(outwardsUnits)} units dispatched</div>
      </div>
    `;

    el.querySelector('#books-meta').innerHTML = `${JKFmt.qty(booksLeaves.length)} items &middot; open any item for its full DC history`;

    function renderRows() {
      const rowsEl = el.querySelector('#books-rows');
      if (!rowsEl) return;
      const q = booksSearch.trim().toLowerCase();
      const rows = booksLeaves.filter((e) => !q || (e.node.name + ' ' + e.breadcrumb).toLowerCase().includes(q));
      if (!rows.length) { rowsEl.innerHTML = `<div class="empty-state">No items match that search.</div>`; return; }
      rowsEl.innerHTML = `
        <div class="book-list-head">
          <div class="bkcol-name">Item</div>
          <div class="bkcol-onhand">On hand</div>
          <div class="bkcol-price">Price &#8377;</div>
          <div class="bkcol-value">Value &#8377;</div>
          <div class="bkcol-in">Inwards</div>
          <div class="bkcol-out">Outwards</div>
          <div class="bkcol-dcs">DCs</div>
        </div>
        ${rows.map((e) => {
          const loc = locById.get(e.node.location_id);
          const qty = Number(e.node.qtyByLocation?.[e.node.location_id] || 0);
          const zero = qty <= 0;
          const mv = moveByItem[e.node.id] || { in: 0, out: 0, n: 0 };
          const value = e.node.price != null ? e.node.price * qty : 0;
          return `
            <button type="button" class="book-row" data-id="${e.node.id}">
              <span class="status-dot${zero ? ' bad' : ''}"></span>
              <span class="bkcol-name">
                <span class="item-name">${esc(e.node.name)}</span>
                <span class="item-crumb">${esc(e.breadcrumb || 'Top level')}</span>
              </span>
              <span class="loc-pill ${loc?.name === 'Fabrication' ? 'fab' : 'finished'}">${esc(loc?.name || '')}</span>
              <span class="bkcol-onhand${zero ? ' zero' : ''}"><span class="qty-num">${JKFmt.qty(qty)}</span><span class="unit"> ${esc(e.node.unit)}</span></span>
              <span class="bkcol-price">${e.node.price != null ? plainNum(e.node.price) : '&mdash;'}</span>
              <span class="bkcol-value">${JKFmt.money(value)}</span>
              <span class="bkcol-in">${mv.in ? '+' + JKFmt.qty(mv.in) : '&mdash;'}</span>
              <span class="bkcol-out">${mv.out ? '&minus;' + JKFmt.qty(mv.out) : '&mdash;'}</span>
              <span class="bkcol-dcs">${mv.n}</span>
            </button>
          `;
        }).join('')}
      `;
      rowsEl.querySelectorAll('.book-row').forEach((row) => { row.onclick = () => openBooksLedger(row.dataset.id); });
    }
    renderRows();
    el.querySelector('#books-search').oninput = debounce((e) => { booksSearch = e.target.value; renderRows(); }, 150);
  }

  // Same leaf-flattening as the location desk's flattenLeavesWithPath, but
  // over the admin global tree (both locations' roots mixed together) and
  // keeping each leaf's own location_id/price for the loc pill + ledger.
  function flattenLeavesWithPathAdmin(nodes) {
    const out = [];
    (function walk(list, chain) {
      list.forEach((n) => {
        if (n.isLeaf) {
          out.push({ node: n, breadcrumb: chain.join(' › ') });
        } else {
          walk(n.children, chain.concat(n.name));
        }
      });
    })(nodes, []);
    return out;
  }

  // Full-screen ledger overlay — same shell as the location desk's, but
  // with admin's stat set (on hand, challans, rate, stock value).
  async function openBooksLedger(itemId) {
    const entry = booksLeaves.find((e) => e.node.id === itemId);
    if (!entry) return;
    const item = entry.node;
    const loc = state.locations.find((l) => l.id === item.location_id);
    let range = { from: '', to: '' };

    const overlay = document.createElement('div');
    overlay.className = 'bookov';
    overlay.innerHTML = `
      <div class="bookov-head">
        <div class="bookov-titles">
          <div class="bookov-eyebrow">Inventory book &middot; ${esc(loc?.name || '')}</div>
          <div class="bookov-name">${esc(item.name)}</div>
          <div class="bookov-crumb">${esc(entry.breadcrumb || 'Top level')}</div>
        </div>
        <div class="bookov-range">
          <label>From <input type="date" id="bookov-from" /></label>
          <label>To <input type="date" id="bookov-to" /></label>
          <button type="button" class="btn btn-sm" id="bookov-range-clear">Clear</button>
        </div>
        <div id="bookov-stats" style="display:flex; gap:20px; flex-wrap:wrap;"></div>
        <button type="button" class="bookov-close" id="bookov-close">Close</button>
      </div>
      <div class="bookov-body"><div class="bookov-card" id="bookov-card"><div class="loading-state">Loading…</div></div></div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#bookov-close').onclick = () => overlay.remove();
    overlay.querySelector('#bookov-from').onchange = (e) => { range.from = e.target.value; loadLedger(); };
    overlay.querySelector('#bookov-to').onchange = (e) => { range.to = e.target.value; loadLedger(); };
    overlay.querySelector('#bookov-range-clear').onclick = () => {
      range = { from: '', to: '' };
      overlay.querySelector('#bookov-from').value = '';
      overlay.querySelector('#bookov-to').value = '';
      loadLedger();
    };

    async function loadLedger() { await renderLedger(); }
    await renderLedger();

    async function renderLedger() {
    const book = await window.JKApi.inventoryBooks({ item_id: itemId, location: item.location_id, from: range.from || undefined, to: range.to ? range.to + 'T23:59:59' : undefined });
    const held = Number(book.closing_balance);
    const rate = item.price != null ? item.price : null;
    const stockValue = rate != null ? rate * held : 0;

    overlay.querySelector('#bookov-stats').innerHTML = [
      { label: `on hand &middot; ${esc(item.unit)}`, value: JKFmt.qty(held), bad: held === 0 },
      { label: 'challans', value: JKFmt.qty(book.entries.length) },
      { label: 'rate', value: rate != null ? JKFmt.money(rate) : '&mdash;' },
      { label: 'stock value', value: JKFmt.money(stockValue) },
    ].map((s) => `<div class="bookov-stat"><div class="value${s.bad ? ' bad' : ''}">${s.value}</div><div class="label">${s.label}</div></div>`).join('');

    const opening = Number(book.opening_balance);
    const short = opening < 0;
    const totalIn = book.entries.filter((e) => e.direction === 'in').reduce((s, e) => s + Number(e.qty), 0);
    const totalOut = book.entries.filter((e) => e.direction === 'out').reduce((s, e) => s + Number(e.qty), 0);
    const rows = book.entries.slice().reverse().map((e) => `
      <a class="bookov-row" href="/dc.html?id=${e.dc_id}" target="_blank" rel="noopener">
        <span class="c-date">${JKFmt.date(e.created_at)}</span>
        <span class="c-dcno">
          <span class="dc-badge ${e.direction}">${e.direction === 'in' ? '&#8595;' : '&#8593;'}</span>
          <span class="dc-no">${esc(e.dc_no)}</span>
        </span>
        <span class="c-part">
          <span class="party">${esc(e.direction === 'in' ? (e.party || 'Stock received') : (e.party || '&mdash;'))}</span>
          <span class="meta">${e.direction === 'in' ? 'Input DC' : 'Output DC'} &middot; ${JKFmt.dateTime(e.created_at).split(' · ')[1] || ''}</span>
        </span>
        <span class="c-in">${e.direction === 'in' ? JKFmt.qty(e.qty) : '&mdash;'}</span>
        <span class="c-out">${e.direction === 'out' ? JKFmt.qty(e.qty) : '&mdash;'}</span>
        <span class="c-bal">${JKFmt.qty(e.balance)}</span>
      </a>
    `).join('');

    overlay.querySelector('#bookov-card').innerHTML = `
      <div class="bookov-thead">
        <span class="c-date">Date</span>
        <span class="c-dcno">DC no.</span>
        <span class="c-part">Particulars</span>
        <span class="c-in">Inwards</span>
        <span class="c-out">Outwards</span>
        <span class="c-bal">Balance</span>
      </div>
      <div class="bookov-obrow${short ? ' short' : ''}">
        <span class="c-date"></span>
        <span class="c-dcno"></span>
        <span class="c-part">Opening balance <span class="note">&middot; ${short ? 'short against recorded DCs' : 'before the DCs below'}</span></span>
        <span class="c-in"></span>
        <span class="c-out"></span>
        <span class="c-bal">${JKFmt.qty(opening)} ${esc(item.unit)}</span>
      </div>
      ${book.entries.length ? rows : `<div class="bookov-empty">No DC has ever touched this item.</div>`}
      <div class="bookov-crow">
        <span class="c-date"></span>
        <span class="c-dcno"></span>
        <span class="c-part">Closing balance</span>
        <span class="c-in">${JKFmt.qty(totalIn)}</span>
        <span class="c-out">${JKFmt.qty(totalOut)}</span>
        <span class="c-bal">${JKFmt.qty(held)} ${esc(item.unit)}</span>
      </div>
    `;
    }
  }

  // ---------------------------------------------------------------
  // DC Log — every DC across both locations. Admin can open any of them
  // (the document page itself carries the edit action — anytime, with the
  // affect-stock choice, since that's an admin-only capability), filter by
  // location/direction/date/search, and export the current filter as CSV.
  // ---------------------------------------------------------------
  let dcsFilters = { location: '', direction: 'all', from: '', to: '', search: '' };

  async function renderDcs(el) {
    document.getElementById('ctx-title').textContent = 'DC Log';
    el.innerHTML = `
      <div class="section-head"><h2>DC Log</h2><div class="meta">Every Input/Output DC across both locations. Open one to view, print, or (admin) correct it — anytime, with the choice of whether the correction moves stock.</div></div>
      <div class="activity-panel">
        <div class="activity-panel-head">
          <div class="title">All DCs</div>
          <div class="meta" id="dcs-count"></div>
          <div class="spacer"></div>
          <select id="dcs-loc" class="btn" style="font-weight:600;">
            <option value="">All locations</option>
            ${state.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}
          </select>
          <label style="display:flex; flex-direction:column; gap:2px; font-size:11px; color:var(--ink-4); font-weight:600;">From
            <input type="date" id="dcs-from" style="height:32px;" />
          </label>
          <label style="display:flex; flex-direction:column; gap:2px; font-size:11px; color:var(--ink-4); font-weight:600;">To
            <input type="date" id="dcs-to" style="height:32px;" />
          </label>
          <div class="search-pill sm"><span class="glyph">&#8981;</span><input id="dcs-search" placeholder="DC no., item or party" /></div>
          <div class="seg" id="dcs-filter">
            <button data-val="all" class="active">All</button>
            <button data-val="in">Input</button>
            <button data-val="out">Output</button>
          </div>
          <button class="btn btn-accent-tint" id="dcs-export">Export CSV</button>
        </div>
        <div class="activity-table-head">
          <div style="flex:0 0 96px;">DC</div>
          <div style="flex:0 0 110px;">Location</div>
          <div style="flex:1 1 auto;">Item and party</div>
          <div style="flex:0 0 130px;">Recorded by</div>
          <div style="flex:0 0 124px; text-align:right; padding-left:10px;">Value &#8377;</div>
          <div style="flex:0 0 104px; text-align:right; padding-left:10px;">When</div>
        </div>
        <div id="dcs-list"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    el.querySelector('#dcs-loc').value = dcsFilters.location;
    el.querySelector('#dcs-from').value = dcsFilters.from;
    el.querySelector('#dcs-to').value = dcsFilters.to;
    el.querySelector('#dcs-search').value = dcsFilters.search;
    el.querySelectorAll('#dcs-filter button').forEach((b) => b.classList.toggle('active', b.dataset.val === dcsFilters.direction));

    async function load() {
      const listEl = el.querySelector('#dcs-list');
      const countEl = el.querySelector('#dcs-count');
      listEl.innerHTML = `<div class="loading-state">Loading…</div>`;
      const { dcs } = await window.JKApi.dcs({
        location: dcsFilters.location || undefined,
        direction: dcsFilters.direction !== 'all' ? dcsFilters.direction : undefined,
        from: dcsFilters.from || undefined,
        to: dcsFilters.to ? dcsFilters.to + 'T23:59:59' : undefined,
      });
      const q = dcsFilters.search.trim().toLowerCase();
      const rows = !q ? dcs : dcs.filter((dc) => {
        const hay = [dc.dc_no, dc.party, ...dc.lines.map((l) => l.item_name)].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
      countEl.textContent = `${JKFmt.qty(rows.length)} of ${JKFmt.qty(dcs.length)} loaded`;
      if (!rows.length) { listEl.innerHTML = `<div class="empty-state">No DCs match this filter.</div>`; return; }
      listEl.innerHTML = rows.map((dc) => {
        const itemsLabel = dc.lines.length ? esc(dc.lines[0].item_name) + (dc.lines.length > 1 ? ` + ${dc.lines.length - 1} more` : '') : '';
        const sub = dc.direction === 'out'
          ? `out to ${esc(dc.party || '')}${dc.note ? ` &middot; ${esc(dc.note)}` : ''}`
          : `${dc.note ? esc(dc.note) : (dc.party ? esc(dc.party) : '')}`;
        return `
          <a class="activity-row" href="/dc.html?id=${dc.id}" target="_blank" rel="noopener">
            <div class="ar-dc">
              <span class="ar-dir ${dc.direction}">${dc.direction === 'in' ? '&#8595;' : '&#8593;'}</span>
              <span class="ar-no">${esc(dc.dc_no)}</span>
            </div>
            <div style="flex:0 0 110px;"><span class="loc-pill ${dc.location_name === 'Fabrication' ? 'fab' : 'finished'}">${esc(dc.location_name || '')}</span></div>
            <div class="ar-main">
              <div class="ar-item">${itemsLabel}</div>
              <div class="ar-sub">${sub}</div>
            </div>
            <div style="flex:0 0 130px; font-size:12.5px; color:var(--ink-4);">${esc(dc.created_by_name || 'Unknown')}${dc.edit_count ? ' <span style="color:var(--accent);">&middot; edited</span>' : ''}</div>
            <div class="ar-value">${JKFmt.money(dc.total_value)}</div>
            <div class="ar-when">${JKFmt.dateTime(dc.created_at)}</div>
          </a>
        `;
      }).join('');
    }

    el.querySelector('#dcs-loc').onchange = (e) => { dcsFilters.location = e.target.value; load(); };
    el.querySelector('#dcs-from').onchange = (e) => { dcsFilters.from = e.target.value; load(); };
    el.querySelector('#dcs-to').onchange = (e) => { dcsFilters.to = e.target.value; load(); };
    el.querySelector('#dcs-search').oninput = debounce((e) => { dcsFilters.search = e.target.value; load(); }, 150);
    el.querySelectorAll('#dcs-filter button').forEach((b) => {
      b.onclick = () => {
        dcsFilters.direction = b.dataset.val;
        el.querySelectorAll('#dcs-filter button').forEach((x) => x.classList.toggle('active', x === b));
        load();
      };
    });
    el.querySelector('#dcs-export').onclick = async (e) => {
      const btn = e.target;
      btn.disabled = true; btn.textContent = 'Exporting…';
      try {
        await window.JKApi.exportDcs({
          location: dcsFilters.location || undefined,
          direction: dcsFilters.direction !== 'all' ? dcsFilters.direction : undefined,
          from: dcsFilters.from || undefined,
          to: dcsFilters.to ? dcsFilters.to + 'T23:59:59' : undefined,
        });
      } catch (err) {
        JKToast.error(err.message);
      }
      btn.disabled = false; btn.textContent = 'Export CSV';
    };

    await load();
  }

  // ---------------------------------------------------------------
  // Edit Log — every correction made to any DC, across both locations, in
  // one place, newest first — so admin doesn't have to open each DC one at
  // a time to see whether/how it was edited. Each row links to that DC's
  // document page, where the same edit also shows in its own history panel.
  // ---------------------------------------------------------------
  let editLogFilters = { location: '', direction: 'all', from: '', to: '' };

  async function renderEditLog(el) {
    document.getElementById('ctx-title').textContent = 'Edit Log';
    el.innerHTML = `
      <div class="section-head"><h2>Edit Log</h2><div class="meta">Every correction made to any DC, across both locations — who made it, when, whether it moved stock, and what changed.</div></div>
      <div class="activity-panel">
        <div class="activity-panel-head">
          <div class="title">All edits</div>
          <div class="meta" id="editlog-count"></div>
          <div class="spacer"></div>
          <select id="editlog-loc" class="btn" style="font-weight:600;">
            <option value="">All locations</option>
            ${state.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}
          </select>
          <label style="display:flex; flex-direction:column; gap:2px; font-size:11px; color:var(--ink-4); font-weight:600;">From
            <input type="date" id="editlog-from" style="height:32px;" />
          </label>
          <label style="display:flex; flex-direction:column; gap:2px; font-size:11px; color:var(--ink-4); font-weight:600;">To
            <input type="date" id="editlog-to" style="height:32px;" />
          </label>
          <div class="seg" id="editlog-filter">
            <button data-val="all" class="active">All</button>
            <button data-val="in">Input</button>
            <button data-val="out">Output</button>
          </div>
        </div>
        <div id="editlog-list"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    el.querySelector('#editlog-loc').value = editLogFilters.location;
    el.querySelector('#editlog-from').value = editLogFilters.from;
    el.querySelector('#editlog-to').value = editLogFilters.to;
    el.querySelectorAll('#editlog-filter button').forEach((b) => b.classList.toggle('active', b.dataset.val === editLogFilters.direction));

    async function load() {
      const listEl = el.querySelector('#editlog-list');
      const countEl = el.querySelector('#editlog-count');
      listEl.innerHTML = `<div class="loading-state">Loading…</div>`;
      let edits;
      try {
        ({ edits } = await window.JKApi.dcEdits({
          location: editLogFilters.location || undefined,
          direction: editLogFilters.direction !== 'all' ? editLogFilters.direction : undefined,
          from: editLogFilters.from || undefined,
          to: editLogFilters.to ? editLogFilters.to + 'T23:59:59' : undefined,
        }));
      } catch (err) {
        listEl.innerHTML = `<div class="empty-state">Could not load the edit log — ${esc(err.message)}</div>`;
        return;
      }
      countEl.textContent = `${JKFmt.qty(edits.length)} edit${edits.length === 1 ? '' : 's'}`;
      if (!edits.length) { listEl.innerHTML = `<div class="empty-state">No edits recorded yet.</div>`; return; }
      listEl.innerHTML = edits.map((e) => `
        <a class="dc-history-row" href="/dc.html?id=${e.dc_id}" target="_blank" rel="noopener" style="display:block; width:100%; text-align:left; background:none; border:none; border-bottom:1px solid var(--rule-3); cursor:pointer; padding:12px 4px; color:inherit; text-decoration:none;">
          <span class="loc-pill ${e.location_name === 'Fabrication' ? 'fab' : 'finished'}">${esc(e.location_name || '')}</span>
          <span class="who">${esc(e.dc_no || '')}</span> &middot;
          <span class="who">${esc(e.edited_by_name || 'Unknown')}</span> &middot;
          ${JKFmt.dateTime(e.edited_at)} &middot;
          <span class="flag ${e.affected_stock ? 'stock' : 'no-stock'}">${e.affected_stock ? 'affected stock' : 'record only'}</span>
          <div style="color:var(--ink-4); margin-top:3px;">${diffSummary(e.before_snapshot, e.after_snapshot)}</div>
        </a>
      `).join('');
    }

    el.querySelector('#editlog-loc').onchange = (e) => { editLogFilters.location = e.target.value; load(); };
    el.querySelector('#editlog-from').onchange = (e) => { editLogFilters.from = e.target.value; load(); };
    el.querySelector('#editlog-to').onchange = (e) => { editLogFilters.to = e.target.value; load(); };
    el.querySelectorAll('#editlog-filter button').forEach((b) => {
      b.onclick = () => {
        editLogFilters.direction = b.dataset.val;
        el.querySelectorAll('#editlog-filter button').forEach((x) => x.classList.toggle('active', x === b));
        load();
      };
    });

    await load();
  }

  // Same before/after diff renderer used on the DC document page's own
  // history panel (public/js/dc-view.js) — duplicated here in miniature
  // rather than shared, since the two files load independently and neither
  // is a build step away from the other.
  function diffSummary(before, after) {
    const parts = [];
    ['party', 'vehicle_no', 'address', 'note'].forEach((k) => {
      if ((before[k] || '') !== (after[k] || '')) parts.push(`${k.replace('_', ' ')}: "${esc(before[k] || '')}" &rarr; "${esc(after[k] || '')}"`);
    });
    const beforeById = new Map((before.lines || []).map((l) => [l.item_id, l]));
    const afterById = new Map((after.lines || []).map((l) => [l.item_id, l]));
    const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
    ids.forEach((id) => {
      const b = beforeById.get(id);
      const a = afterById.get(id);
      if (b && a && Number(b.qty) !== Number(a.qty)) parts.push(`${esc(a.item_name)}: ${JKFmt.qty(b.qty)} &rarr; ${JKFmt.qty(a.qty)} ${esc(a.unit)}`);
      else if (b && !a) parts.push(`${esc(b.item_name)}: removed`);
      else if (a && !b) parts.push(`${esc(a.item_name)}: added (${JKFmt.qty(a.qty)} ${esc(a.unit)})`);
    });
    return parts.length ? parts.join(' &middot; ') : 'No field or quantity changes.';
  }

  // ---------------------------------------------------------------
  // Prices editor — one universal price per item, grouped by location >
  // top-level category. Not kind-tabbed: materials and consumables appear
  // together, grouped by category.
  // ---------------------------------------------------------------
  let priceData = [];
  let priceNodeById = new Map();

  async function renderPrices(el) {
    document.getElementById('ctx-title').textContent = 'Universal prices';
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
      ${state.openActionId === node.id ? renderActionPanel(node, locId, isLeaf, depth) : ''}
    `);
    if (!isLeaf && expanded) {
      const childChain = depth === 0 ? [] : [isLast].concat(parentChain);
      node.children.forEach((c, i) => renderTreesNode(c, locId, childChain, i === node.children.length - 1, out, depth + 1));
    }
  }

  // Mockup-exact: an uppercase name label, then the row's own actions in
  // the mockup's order (Rename first; a category gets "+ Sub-category" and
  // "+ Item" as two distinct buttons rather than one "+ Sub-item" with a
  // checkbox; a leaf gets Change price / Low-stock alert), Re-parent, then
  // Archive. "Make into category" is appended last — it has no mockup
  // equivalent, it exists only to recover an item that was mismarked as a
  // leaf before the is_leaf fix.
  function renderActionPanel(node, locId, isLeaf, depth) {
    const padLeft = 31 + 20 * (depth || 0);
    return `
      <div class="item-action-panel" style="padding-left:${padLeft}px;">
        <span class="item-action-label">${esc(node.name)}</span>
        <button class="btn btn-sm" data-act="rename" data-id="${node.id}" data-name="${esc(node.name)}">Rename</button>
        ${!isLeaf ? `<button class="btn btn-sm" data-act="add-subcategory" data-id="${node.id}" data-name="${esc(node.name)}" data-loc="${locId}">+ Sub-category</button>` : ''}
        ${!isLeaf ? `<button class="btn btn-sm" data-act="add-item" data-id="${node.id}" data-name="${esc(node.name)}" data-loc="${locId}">+ Item</button>` : ''}
        ${isLeaf ? `<button class="btn btn-sm" data-act="price" data-id="${node.id}" data-price="${node.price ?? ''}">Change price</button>` : ''}
        ${isLeaf ? `<button class="btn btn-sm" data-act="threshold" data-id="${node.id}" data-loc="${locId}">Low-stock alert</button>` : ''}
        <button class="btn btn-sm" data-act="reparent" data-id="${node.id}" data-loc="${locId}">Re-parent</button>
        <button class="btn btn-sm btn-danger" data-act="archive" data-id="${node.id}">Archive</button>
        ${isLeaf ? `<button class="btn btn-sm" data-act="to-category" data-id="${node.id}">Make into category</button>` : ''}
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
    wrap.querySelectorAll('[data-act="add-subcategory"]').forEach((btn) => {
      btn.onclick = () => { state.openActionId = null; openItemForm(btn.dataset.id, btn.dataset.loc, () => renderTrees(document.getElementById('view-root')), false, btn.dataset.name); };
    });
    wrap.querySelectorAll('[data-act="add-item"]').forEach((btn) => {
      btn.onclick = () => { state.openActionId = null; openItemForm(btn.dataset.id, btn.dataset.loc, () => renderTrees(document.getElementById('view-root')), true, btn.dataset.name); };
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
    wrap.querySelectorAll('[data-act="to-category"]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Turn this into a category? It will stop holding stock directly — you\'ll add sub-items under it instead.')) return;
        try {
          await window.JKApi.updateItem(btn.dataset.id, { is_leaf: false });
          JKToast.good('Now a category.');
          state.openActionId = null;
          renderTrees(document.getElementById('view-root'));
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

  // A top-level node is always a category (server forces is_leaf: false).
  // For a sub-node, the mockup's two distinct buttons ("+ Sub-category" vs
  // "+ Item") decide is_leaf directly via forceLeaf — no checkbox needed.
  //
  // Modal chrome (title/subtitle/hint-box pattern) replicated one-to-one
  // from the mockup's "New category" dialog (Item trees, Fabrication,
  // "+ Top-level category" and "+ Sub-category"). The mockup reuses that
  // same dialog for "+ Item" too (it's a non-functional demo, no Unit
  // field either way) — here "New item" gets its own title plus the Unit
  // field our schema actually needs, since a real leaf item has to record
  // a unit; the category copy/hint-box otherwise matches the mockup exactly.
  function openItemForm(parentId, locId, onDone, forceLeaf, parentName) {
    const isItem = !!parentId && !!forceLeaf;
    const locName = (state.locations.find((l) => l.id === locId) || {}).name || '';
    const kindLabel = state.kind === 'consumable' ? 'consumables' : 'materials';
    const subtitle = !parentId
      ? `${locName} · top level · ${kindLabel}`
      : `${locName} · inside ${parentName || ''}`;
    const title = isItem ? 'New item' : 'New category';

    openModal(title, `
      <div class="field"><label>${isItem ? 'Item name' : 'Category name'}</label><input id="f-name" placeholder="e.g. Steel sheets" /></div>
      ${isItem ? `<div class="field"><label>Unit</label><input id="f-unit" placeholder="e.g. sheets, pieces, sets, kg" value="pcs" /></div>` : ''}
      ${!isItem ? `<div class="modal-hint">A category holds no stock of its own. Its number is always the sum of the items nested under it.</div>` : ''}
      <div class="field error hidden" id="f-error"></div>
    `, [
      { label: 'Cancel', onClick: () => closeModal() },
      {
        label: 'Add', primary: true, onClick: async (btn) => {
          const name = document.getElementById('f-name').value.trim();
          const unitEl = document.getElementById('f-unit');
          const unit = (unitEl ? unitEl.value.trim() : '') || 'pcs';
          const errorEl = document.getElementById('f-error');
          if (!name) { errorEl.textContent = 'Name is required.'; errorEl.classList.remove('hidden'); return; }
          btn.disabled = true;
          try {
            await window.JKApi.createItem({
              name, unit, kind: state.kind,
              parent_id: parentId || undefined,
              location_id: parentId ? undefined : locId,
              is_leaf: parentId ? !!forceLeaf : undefined,
            });
            closeModal();
            JKToast.good('Created.');
            onDone();
          } catch (err) {
            errorEl.textContent = err.message; errorEl.classList.remove('hidden'); btn.disabled = false;
          }
        },
      },
    ], { subtitle });
  }

  // Re-parent: a leaf/category can only move within its own location's
  // tree (a leaf can't cross locations — the DB trigger rejects that
  // anyway), so the select is scoped to that location's own categories.
  // The item itself, and everything nested under it, is excluded from the
  // list of valid destinations — moving a category under its own
  // descendant would create a cycle.
  function openReparentModal(itemId, locId) {
    const section = treesData.find((t) => t.loc.id === locId);
    const options = [];
    (function walk(nodes, path) {
      (nodes || []).forEach((n) => {
        if (n.id === itemId) return; // skip it and everything below it
        if (!n.isLeaf) {
          options.push({ id: n.id, label: path.concat(n.name).join(' › ') });
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
  // Users — admin can provision new logins (no mockup screen for this;
  // built to match the app's own design system: the book-list chrome for
  // the list, the shared openModal helper for the create/reset forms).
  // ---------------------------------------------------------------
  async function renderUsers(el) {
    document.getElementById('ctx-title').textContent = 'Users';
    el.innerHTML = `
      <div class="book-list" id="users-card">
        <div class="book-card-head">
          <div class="titles">
            <div class="h">Logins</div>
            <div class="sub" id="users-meta">Loading…</div>
          </div>
          <button class="btn btn-primary" id="btn-add-user">+ Add user</button>
        </div>
        <div id="users-rows"><div class="loading-state">Loading…</div></div>
      </div>
    `;
    el.querySelector('#btn-add-user').onclick = () => openUserForm();

    let users;
    try {
      ({ users } = await window.JKApi.users());
    } catch (err) {
      el.querySelector('#users-rows').innerHTML = `<div class="empty-state">Could not load users — ${esc(err.message)}</div>`;
      return;
    }

    el.querySelector('#users-meta').textContent = `${JKFmt.qty(users.length)} login${users.length === 1 ? '' : 's'}`;

    const rowsEl = el.querySelector('#users-rows');
    if (!users.length) {
      rowsEl.innerHTML = `<div class="empty-state">No logins yet.</div>`;
      return;
    }
    rowsEl.innerHTML = users.map((u) => `
      <div class="user-row" data-id="${u.id}">
        <span class="user-row-main">
          <span class="item-name">${esc(u.full_name)}</span>
          <span class="item-crumb">${esc(u.email || '')}</span>
        </span>
        <span class="loc-pill ${u.role === 'admin' ? '' : (u.location_name === 'Fabrication' ? 'fab' : 'finished')}">${u.role === 'admin' ? 'Admin' : esc(u.location_name || '—')}</span>
        <span class="user-row-actions">
          <button class="btn btn-sm" data-act="reset-password" data-id="${u.id}" data-name="${esc(u.full_name)}">Reset password</button>
          <button class="btn btn-sm btn-danger" data-act="remove-user" data-id="${u.id}" data-name="${esc(u.full_name)}">Remove</button>
        </span>
      </div>
    `).join('');

    rowsEl.querySelectorAll('[data-act="reset-password"]').forEach((btn) => {
      btn.onclick = () => openResetPasswordForm(btn.dataset.id, btn.dataset.name);
    });
    rowsEl.querySelectorAll('[data-act="remove-user"]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm(`Remove ${btn.dataset.name}'s login? They will no longer be able to sign in.`)) return;
        try {
          await window.JKApi.deleteUser(btn.dataset.id);
          JKToast.good('Login removed.');
          renderUsers(document.getElementById('view-root'));
        } catch (err) { JKToast.error(err.message); }
      };
    });
  }

  function openUserForm() {
    openModal('Add user', `
      <div class="field"><label>Full name</label><input id="f-name" /></div>
      <div class="field"><label>Email</label><input id="f-email" type="email" autocomplete="off" /></div>
      <div class="field"><label>Password</label><input id="f-password" type="password" autocomplete="new-password" placeholder="At least 8 characters" /></div>
      <div class="field">
        <label>Role</label>
        <select id="f-role">
          <option value="operator">Operator (pinned to one location)</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <div class="field" id="f-location-field">
        <label>Location</label>
        <select id="f-location">
          ${state.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field error hidden" id="f-error"></div>
    `, [
      { label: 'Cancel', onClick: () => closeModal() },
      {
        label: 'Create login', primary: true, onClick: async (btn) => {
          const full_name = document.getElementById('f-name').value.trim();
          const email = document.getElementById('f-email').value.trim();
          const password = document.getElementById('f-password').value;
          const role = document.getElementById('f-role').value;
          const location_id = document.getElementById('f-location').value;
          const errorEl = document.getElementById('f-error');
          if (!full_name || !email || !password) {
            errorEl.textContent = 'Name, email and password are all required.'; errorEl.classList.remove('hidden'); return;
          }
          btn.disabled = true;
          try {
            await window.JKApi.createUser({
              full_name, email, password, role,
              location_id: role === 'operator' ? location_id : undefined,
            });
            closeModal();
            JKToast.good('Login created.');
            renderUsers(document.getElementById('view-root'));
          } catch (err) {
            errorEl.textContent = err.message; errorEl.classList.remove('hidden'); btn.disabled = false;
          }
        },
      },
    ]);
    const roleEl = document.getElementById('f-role');
    const locField = document.getElementById('f-location-field');
    const syncLocField = () => { locField.style.display = roleEl.value === 'operator' ? '' : 'none'; };
    roleEl.onchange = syncLocField;
    syncLocField();
  }

  function openResetPasswordForm(userId, name) {
    openModal(`Reset password — ${name}`, `
      <div class="field"><label>New password</label><input id="f-password" type="password" autocomplete="new-password" placeholder="At least 8 characters" /></div>
      <div class="field error hidden" id="f-error"></div>
    `, [
      { label: 'Cancel', onClick: () => closeModal() },
      {
        label: 'Reset password', primary: true, onClick: async (btn) => {
          const password = document.getElementById('f-password').value;
          const errorEl = document.getElementById('f-error');
          if (!password) { errorEl.textContent = 'Enter a new password.'; errorEl.classList.remove('hidden'); return; }
          btn.disabled = true;
          try {
            await window.JKApi.updateUser(userId, { password });
            closeModal();
            JKToast.good('Password reset.');
          } catch (err) {
            errorEl.textContent = err.message; errorEl.classList.remove('hidden'); btn.disabled = false;
          }
        },
      },
    ]);
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
        <div class="modal-head">
          <div class="modal-head-text"><div class="title">${esc(title)}</div>${opts && opts.subtitle ? `<div class="subtitle">${esc(opts.subtitle)}</div>` : ''}</div>
          <button class="btn btn-ghost icon" id="modal-close">&times;</button>
        </div>
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
