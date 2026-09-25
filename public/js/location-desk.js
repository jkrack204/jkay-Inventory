// Shared "location desk" app — used identically by fab.html and
// finished.html, each of which just sets window.__JKAY_LOCATION_NAME__
// before loading this file. Per the build plan, Fabrication and Finished
// are the same screen pointed at different data, not two different apps.

(function () {
  const LOCATION_NAME = window.__JKAY_LOCATION_NAME__; // 'Fabrication' | 'Finished'
  const OTHER_NAME = LOCATION_NAME === 'Fabrication' ? 'Finished' : 'Fabrication';

  const state = {
    user: null,
    location: null,
    otherLocation: null,
    kind: 'material',
    tree: [],
    expanded: new Set(),
    search: '',
    view: 'tree', // 'tree' | 'activity' | 'alerts' | 'book' | 'peek' | 'mine'
    bookItem: null,
    peekTree: [],
    peekExpanded: new Set(),
    peekSearch: '',
  };

  const root = document.getElementById('app');
  // Last-known out-of-stock count for this location, refreshed in the
  // background on every render() (see below) — read by the Settings modal.
  // Starts at 0 rather than blocking the first paint on a network round-trip.
  let lastOutOfStock = 0;

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  async function boot() {
    const session = await window.JKAuth.requireSession();
    if (!session) return;

    try {
      const [{ user }, { locations }] = await Promise.all([window.JKApi.me(), window.JKApi.locations()]);
      state.user = user;
      state.location = locations.find((l) => l.name === LOCATION_NAME);
      state.otherLocation = locations.find((l) => l.name === OTHER_NAME);
      if (!state.location) throw new Error(`Location "${LOCATION_NAME}" not found`);
    } catch (err) {
      root.innerHTML = `<div class="empty-state">Could not load your account — ${escapeHtml(err.message)}</div>`;
      return;
    }

    window.addEventListener('hashchange', route);
    route();
  }

  function route() {
    const hash = window.location.hash.replace('#', '');
    if (hash.startsWith('book/')) {
      state.view = 'book';
      state.bookItem = hash.slice(5);
    } else if (hash === 'book' || hash === 'activity' || hash === 'alerts' || hash === 'peek' || hash === 'mine') {
      state.view = hash;
    } else {
      state.view = 'tree';
    }
    render();
  }

  // ---------------------------------------------------------------
  // Render shell
  // ---------------------------------------------------------------
  function render() {
    // The "N out of stock" badge used to be fetched and AWAITED before the
    // shell (header + page) was even drawn — every single navigation paid
    // for a full network round-trip before anything appeared on screen.
    // Now the shell renders immediately with a plain "Alerts" button, and
    // the badge count is fetched in the background and swapped in once it
    // arrives — off the critical path of every page view.
    root.innerHTML = `
      <header class="topbar">
        ${window.JKUi.logoMarkHtml()}
        <div class="divider"></div>
        <div class="context">
          <div class="eyebrow">Stock at</div>
          <div class="title">${escapeHtml(LOCATION_NAME)}</div>
        </div>
        <div class="spacer"></div>
        ${state.view !== 'tree' ? `<button class="btn btn-back" id="btn-desk-home">&larr; Desk</button>` : ''}
        <span class="status-pill"><span class="dot dot-good"></span>${escapeHtml(OTHER_NAME)} keeps its own stock</span>
        <button class="btn${state.view === 'peek' ? ' active' : ''}" id="btn-peek-nav">${escapeHtml(OTHER_NAME)} stock</button>
        <button class="btn${state.view === 'book' ? ' active' : ''}" id="btn-book-nav">Inventory book</button>
        <button class="btn${state.view === 'mine' ? ' active' : ''}" id="btn-mine-nav">My DCs</button>
        <span id="alerts-nav-slot"><button class="btn${state.view === 'alerts' ? ' active' : ''}" id="btn-alerts-nav">Alerts</button></span>
        <button class="btn-gear" id="btn-settings" title="Settings">&#9881;</button>
        <button class="btn icon" id="btn-signout" title="Sign out">&#8594;</button>
      </header>
      <div class="page" id="view-root"></div>
    `;
    const homeBtn = document.getElementById('btn-desk-home');
    if (homeBtn) homeBtn.onclick = () => { window.location.hash = ''; };
    document.getElementById('btn-book-nav').onclick = () => { window.location.hash = 'book'; };
    wireAlertsNav();
    document.getElementById('btn-peek-nav').onclick = () => { window.location.hash = 'peek'; };
    document.getElementById('btn-mine-nav').onclick = () => { window.location.hash = 'mine'; };
    document.getElementById('btn-signout').onclick = () => window.JKAuth.signOut();
    document.getElementById('btn-settings').onclick = () => {
      window.JKUi.openSettingsModal({
        lowStockThreshold: state.location?.default_threshold,
        lowStockCount: lastOutOfStock,
        onChange: (p) => { state.expanded.clear(); if (p.expandDefault) state._expandAll = true; else state._expandAll = false; if (state.view === 'tree') renderTreeBody(); },
      });
    };

    const viewRoot = document.getElementById('view-root');
    if (state.view === 'tree') renderTreeView(viewRoot);
    else if (state.view === 'activity') renderActivityView(viewRoot);
    else if (state.view === 'alerts') renderAlertsView(viewRoot);
    else if (state.view === 'book') renderBookView(viewRoot);
    else if (state.view === 'peek') renderPeekView(viewRoot);
    else if (state.view === 'mine') renderMyDcsView(viewRoot);

    refreshOutOfStockBadge();
  }

  function wireAlertsNav() {
    const btn = document.getElementById('btn-alerts-nav');
    if (btn) btn.onclick = () => { window.location.hash = 'alerts'; };
  }

  // /api/low-stock only ever returns items with 0 < qty <= threshold
  // (zero-qty items are explicitly excluded there — see reports.js), so
  // filtering it for qty <= 0 always came back empty and the "N out of
  // stock" badge never showed. Use /api/out-of-stock instead. Fetched in
  // the background (not awaited by render()) so it never delays the page.
  async function refreshOutOfStockBadge() {
    let count = 0;
    try {
      const r = await window.JKApi.outOfStock({ location: state.location.id });
      count = (r.out_of_stock || []).length;
    } catch (e) { /* leave the plain Alerts button up */ }
    lastOutOfStock = count;
    const slot = document.getElementById('alerts-nav-slot');
    if (!slot) return; // navigated away before this resolved
    slot.innerHTML = count > 0
      ? `<button class="badge-out" id="btn-alerts-nav">${count} out of stock</button>`
      : `<button class="btn${state.view === 'alerts' ? ' active' : ''}" id="btn-alerts-nav">Alerts</button>`;
    wireAlertsNav();
  }

  // ---------------------------------------------------------------
  // My DCs — every DC this login recorded, with an Edit action while
  // still inside the 24-hour buffer (server enforces the same window;
  // is_editable here is just what the server already told us).
  // ---------------------------------------------------------------
  async function renderMyDcsView(el) {
    el.innerHTML = `
      <div class="section-head"><h2>My DCs</h2><div class="meta">Every DC you've recorded at ${escapeHtml(LOCATION_NAME)}. You can correct one yourself for 24 hours after recording it — after that, ask an admin.</div></div>
      <div class="tree-table" id="mine-list"><div class="loading-state">Loading…</div></div>
    `;
    const listEl = el.querySelector('#mine-list');
    const { dcs } = await window.JKApi.dcs({ location: state.location.id });
    const mine = dcs.filter((dc) => dc.created_by === state.user.id);
    if (!mine.length) { listEl.innerHTML = `<div class="empty-state">You haven't recorded any DCs yet.</div>`; return; }
    listEl.innerHTML = mine.map((dc) => {
      const first = dc.lines[0];
      const extra = dc.lines.length - 1;
      return `
        <a class="dc-row" href="/dc.html?id=${dc.id}" target="_blank">
          <div class="dc-dir ${dc.direction}">${dc.direction === 'in' ? '↓' : '↑'}</div>
          <div class="main">
            <div class="dc-line1"><b>${JKFmt.qty(first.qty)} ${escapeHtml(first.unit)}</b> ${escapeHtml(first.item_name)}${extra > 0 ? ` + ${extra} more` : ''}</div>
            <div class="dc-line2">${dc.is_editable ? 'Editable for a bit longer' : 'Edit window has passed'}${dc.edit_count ? ' · edited' : ''}</div>
          </div>
          <div class="dc-right">
            <div class="dc-no">${escapeHtml(dc.dc_no)}</div>
            <div class="dc-time">${JKFmt.dateTime(dc.created_at)}</div>
          </div>
        </a>
      `;
    }).join('');
  }

  // ---------------------------------------------------------------
  // Peek view — read-only look at the OTHER location's stock. No DC
  // buttons, no price, nothing writable: this is a view, not a desk.
  // ---------------------------------------------------------------
  async function renderPeekView(el) {
    el.innerHTML = `
      <div class="section-head"><h2>${escapeHtml(OTHER_NAME)} stock</h2><div class="meta">Read-only — you can't raise a DC here.</div></div>
      <div class="tree-toolbar">
        <div class="tabs">
          <button class="tab ${state.kind === 'material' ? 'active' : ''}" data-kind="material">Materials</button>
          <button class="tab ${state.kind === 'consumable' ? 'active' : ''}" data-kind="consumable">Consumables</button>
        </div>
        <input autocomplete="off" class="search-input" id="peek-search" placeholder="Search items" value="${escapeHtml(state.peekSearch)}" />
      </div>
      <div class="tree-table">
        <div class="tree-head">
          <div class="col-name">${state.kind === 'material' ? 'Material' : 'Consumable'}</div>
          <div class="col-qty">On hand</div>
        </div>
        <div id="peek-body"><div class="loading-state">Loading…</div></div>
      </div>
    `;
    el.querySelectorAll('.tab').forEach((btn) => {
      btn.onclick = () => { state.kind = btn.dataset.kind; renderPeekView(el); };
    });
    el.querySelector('#peek-search').oninput = debounce((e) => { state.peekSearch = e.target.value; renderPeekBody(); }, 150);

    const { items } = await window.JKApi.items({ kind: state.kind, peek: 1 });
    state.peekTree = items;
    renderPeekBody();
  }

  function renderPeekBody() {
    const body = document.getElementById('peek-body');
    if (!body) return;
    const q = state.peekSearch.trim();
    const roots = state.peekTree.filter((n) => matchesSearch(n, q));
    if (!roots.length) { body.innerHTML = `<div class="empty-state">No items found.</div>`; return; }
    if (q) roots.forEach((n) => expandForSearchInto(n, q, state.peekExpanded));
    const rowsHtml = [];
    roots.forEach((n, i) => renderPeekNode(n, [], i === roots.length - 1, rowsHtml));
    body.innerHTML = rowsHtml.join('');
    body.querySelectorAll('.toggle').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        if (state.peekExpanded.has(id)) state.peekExpanded.delete(id); else state.peekExpanded.add(id);
        renderPeekBody();
      };
    });
  }

  function expandForSearchInto(node, q, expandedSet) {
    if (!node.children || !node.children.length) return;
    if (node.children.some((c) => matchesSearch(c, q))) {
      expandedSet.add(node.id);
      node.children.forEach((c) => expandForSearchInto(c, q, expandedSet));
    }
  }

  // Same connector-line shape as renderNode, but read-only: no quick-DC
  // buttons, and quantity is just whatever that location's own qty map
  // (peeked items key their own qty by their own location id).
  function renderPeekNode(node, parentChain, isLast, out, depth) {
    depth = depth || 0;
    const qty = Number(Object.values(node.qtyByLocation || {})[0] || 0);
    const isLeaf = node.isLeaf;
    depth = depth || 0;

    const connectorDefs = depth === 0 ? [] : [{ vlineOff: isLast, corner: true }].concat(
      parentChain.map((wasLast) => ({ vlineOff: wasLast, corner: false }))
    );
    const connectors = connectorDefs.map((c) => `
      <span class="connector">
        <span class="vline${c.vlineOff ? ' off' : ''}"></span>
        <span class="corner${c.corner ? '' : ' off'}"></span>
      </span>
    `).join('');

    if (isLeaf) {
      out.push(`
        <div class="tree-row leaf${qty <= 0 ? ' low' : ''}">
          <div class="row-main">
            ${connectors}
            <span class="disclosure"><span class="status-dot${qty <= 0 ? ' bad' : ''}"></span></span>
            <span class="names">
              <span class="item-name">${escapeHtml(node.name)}</span>
              <span class="item-sub">${escapeHtml(node.unit)}</span>
            </span>
          </div>
          <div class="col-qty"><span class="qty-num">${JKFmt.qty(qty)}</span><span class="unit"> ${escapeHtml(node.unit)}</span></div>
        </div>
      `);
    } else {
      const expanded = state.peekExpanded.has(node.id);
      const isTop = depth === 0;
      out.push(`
        <div class="tree-row parent${isTop ? ' top-parent' : ''}">
          <div class="row-main">
            ${connectors}
            <span class="disclosure"><button class="toggle${expanded ? ' open' : ''}" data-id="${node.id}">&#9654;</button></span>
            <span class="names">
              <span class="item-name">${escapeHtml(node.name)}</span>
              <span class="item-sub">${node.children.length} item${node.children.length === 1 ? '' : 's'} below &middot; rolled up</span>
            </span>
          </div>
          <div class="col-qty"><span class="qty-num">${JKFmt.qty(qty)}</span><span class="unit"> ${escapeHtml(node.unit)}</span></div>
        </div>
      `);
      if (expanded) {
        const childChain = depth === 0 ? [] : [isLast].concat(parentChain);
        node.children.forEach((c, i) => renderPeekNode(c, childChain, i === node.children.length - 1, out, depth + 1));
      }
    }
  }

  // ---------------------------------------------------------------
  // Tree view (home)
  // ---------------------------------------------------------------
  async function renderTreeView(el) {
    el.innerHTML = `
      <div class="action-tiles">
        <div class="action-tile in" id="tile-in">
          <div class="icon">&#8595;</div>
          <div><div class="title">Input DC</div><div class="sub">Material arriving at ${escapeHtml(LOCATION_NAME)}</div></div>
        </div>
        <div class="action-tile out" id="tile-out">
          <div class="icon">&#8593;</div>
          <div><div class="title">Output DC</div><div class="sub">Material leaving ${escapeHtml(LOCATION_NAME)}</div></div>
        </div>
      </div>
      <div class="tree-toolbar">
        <div class="tabs">
          <button class="tab ${state.kind === 'material' ? 'active' : ''}" data-kind="material">Materials</button>
          <button class="tab ${state.kind === 'consumable' ? 'active' : ''}" data-kind="consumable">Consumables</button>
        </div>
        <div style="display:flex; gap:10px;">
          <input autocomplete="off" class="search-input" id="search" placeholder="Search items" value="${escapeHtml(state.search)}" />
          <button class="btn" id="btn-collapse">Collapse all</button>
        </div>
      </div>
      <div class="tree-table">
        <div class="tree-head">
          <div class="col-name">${state.kind === 'material' ? 'Material' : 'Consumable'}</div>
          <div class="col-qty">On hand</div>
        </div>
        <div id="tree-body"><div class="loading-state">Loading…</div></div>
      </div>
    `;
    el.querySelector('#tile-in').onclick = () => openDcWizard('in');
    el.querySelector('#tile-out').onclick = () => openDcWizard('out');
    el.querySelectorAll('.tab').forEach((btn) => {
      btn.onclick = () => { state.kind = btn.dataset.kind; renderTreeView(el); };
    });
    el.querySelector('#btn-collapse').onclick = () => { state.expanded.clear(); renderTreeBody(); };
    const searchEl = el.querySelector('#search');
    searchEl.oninput = debounce(() => { state.search = searchEl.value; renderTreeBody(); }, 150);

    await loadTree();
    renderTreeBody();
  }

  async function loadTree() {
    const { items } = await window.JKApi.items({ kind: state.kind, location: state.location.id });
    state.tree = items;
    const prefs = window.JKUi.getPrefs();
    if (prefs.expandDefault) {
      (function expandAll(nodes) {
        nodes.forEach((n) => { if (!n.isLeaf) { state.expanded.add(n.id); expandAll(n.children); } });
      })(state.tree);
    }
  }

  function matchesSearch(node, q) {
    if (!q) return true;
    if (node.name.toLowerCase().includes(q.toLowerCase())) return true;
    return (node.children || []).some((c) => matchesSearch(c, q));
  }

  function renderTreeBody() {
    const body = document.getElementById('tree-body');
    if (!body) return;
    const q = state.search.trim();
    const prefs = window.JKUi.getPrefs();
    let roots = state.tree.filter((n) => matchesSearch(n, q));
    if (prefs.hideZero) roots = roots.filter((n) => !isAllZero(n)).map((n) => filterZero(n)).filter(Boolean);
    if (!roots.length) {
      body.innerHTML = `<div class="empty-state">No items found.</div>`;
      return;
    }
    if (q) roots.forEach((n) => expandForSearch(n, q));
    // Precompute, per node, whether it is the last child among its rendered
    // siblings — needed by the connector-line renderer to know whether an
    // ancestor's vertical line should keep going past this row or stop.
    const rowsHtml = [];
    roots.forEach((n, i) => renderNode(n, [], i === roots.length - 1, rowsHtml));
    body.innerHTML = rowsHtml.join('');
    body.querySelectorAll('.toggle').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
        renderTreeBody();
      };
    });
    body.querySelectorAll('.mini-btn.in').forEach((btn) => {
      btn.onclick = () => openDcWizard('in', btn.dataset.id);
    });
    body.querySelectorAll('.mini-btn.out').forEach((btn) => {
      btn.onclick = () => openDcWizard('out', btn.dataset.id);
    });
  }

  function isAllZero(node) {
    if (node.isLeaf) return qtyFor(node) <= 0;
    return node.children.every(isAllZero);
  }
  function filterZero(node) {
    if (node.isLeaf) return qtyFor(node) > 0 ? node : null;
    const kids = node.children.map(filterZero).filter(Boolean);
    if (!kids.length) return null;
    return Object.assign({}, node, { children: kids });
  }

  function expandForSearch(node, q) {
    if (!node.children || !node.children.length) return;
    const childMatches = node.children.some((c) => matchesSearch(c, q));
    if (childMatches) {
      state.expanded.add(node.id);
      node.children.forEach((c) => expandForSearch(c, q));
    }
  }

  function qtyFor(node) {
    return Number(node.qtyByLocation?.[state.location.id] || 0);
  }

  function isLowStock(node) {
    const qty = qtyFor(node);
    const threshold = Number(node.threshold ?? node.low_stock_threshold ?? 0);
    return qty <= 0 || (threshold > 0 && qty <= threshold);
  }

  // Renders one node and (if a category) its children, recursively.
  //
  // Connector columns (verified against the real mockup DOM): a node at
  // depth D gets D connector spans, ordered [own-elbow, ancestor
  // pass-throughs nearest-to-farthest]. The own-elbow column (leftmost)
  // always has a solid corner and its vline is off iff this node is the
  // last child of its immediate parent. Each pass-through column has a
  // transparent (invisible) corner and its vline is off iff the
  // corresponding ancestor was the last child at its own level.
  // `parentChain` carries those ancestor "was-last" flags, nearest first.
  function renderNode(node, parentChain, isLast, out, depth) {
    const qty = qtyFor(node);
    const isLeaf = node.isLeaf;
    depth = depth || 0;
    const low = isLeaf && isLowStock(node);

    const connectorDefs = depth === 0 ? [] : [{ vlineOff: isLast, corner: true }].concat(
      parentChain.map((wasLast) => ({ vlineOff: wasLast, corner: false }))
    );
    const connectors = connectorDefs.map((c) => `
      <span class="connector">
        <span class="vline${c.vlineOff ? ' off' : ''}"></span>
        <span class="corner${c.corner ? '' : ' off'}"></span>
      </span>
    `).join('');

    if (isLeaf) {
      out.push(`
        <div class="tree-row leaf${low ? ' low' : ''}">
          <div class="row-main">
            ${connectors}
            <span class="disclosure"><span class="status-dot${low ? ' bad' : ''}"></span></span>
            <span class="names">
              <span class="item-name">${escapeHtml(node.name)}</span>
              <span class="item-sub">${escapeHtml(node.unit)}</span>
            </span>
          </div>
          <div class="col-qty"><span class="qty-num">${JKFmt.qty(qty)}</span><span class="unit"> ${escapeHtml(node.unit)}</span></div>
          <div class="col-actions">
            <button class="mini-btn in" data-id="${node.id}" title="Input DC">&#8595;</button>
            <button class="mini-btn out" data-id="${node.id}" data-max="${qty}" ${qty <= 0 ? 'disabled' : ''} title="Output DC">&#8593;</button>
          </div>
        </div>
      `);
    } else {
      const expanded = state.expanded.has(node.id);
      const isTop = depth === 0;
      out.push(`
        <div class="tree-row parent${isTop ? ' top-parent' : ''}">
          <div class="row-main">
            ${connectors}
            <span class="disclosure">
              <button class="toggle${expanded ? ' open' : ''}" data-id="${node.id}">&#9654;</button>
            </span>
            <span class="names">
              <span class="item-name">${escapeHtml(node.name)}</span>
              <span class="item-sub">${node.children.length} item${node.children.length === 1 ? '' : 's'} below &middot; rolled up</span>
            </span>
          </div>
          <div class="col-qty"><span class="qty-num">${JKFmt.qty(qty)}</span><span class="unit"> ${escapeHtml(node.unit)}</span></div>
          <div class="col-actions"></div>
        </div>
      `);
      if (expanded) {
        const childChain = depth === 0 ? [] : [isLast].concat(parentChain);
        node.children.forEach((c, i) => renderNode(c, childChain, i === node.children.length - 1, out, depth + 1));
      }
    }
  }

  // ---------------------------------------------------------------
  // Activity view
  // ---------------------------------------------------------------
  async function renderActivityView(el) {
    let filter = 'all'; // 'all' | 'in' | 'out'
    el.innerHTML = `
      <div class="tree-table">
        <div class="activity-head">
          <div>
            <span class="title">Recent DCs at ${escapeHtml(LOCATION_NAME)}</span>
            <span class="count" id="dc-count"></span>
          </div>
          <div class="spacer"></div>
          <div class="search-pill">&#8981;<input autocomplete="off" id="dc-search" placeholder="Search DC no. / item / party" /></div>
          <div class="filter-seg" id="dc-filter">
            <button data-val="all" class="active">All</button>
            <button data-val="in">In</button>
            <button data-val="out">Out</button>
          </div>
        </div>
        <div id="dc-list"><div class="loading-state">Loading…</div></div>
      </div>
    `;
    const listEl = el.querySelector('#dc-list');
    const countEl = el.querySelector('#dc-count');
    async function load(term) {
      // The server's dc_no/party filters are ANDed together, so passing the
      // same free-text term to both would only match a DC whose number AND
      // party both happen to contain it — wrong for an "any of these
      // fields" search box. Fetch this location's DCs unfiltered and match
      // DC no. / item name / party ourselves instead, which also covers
      // the "item" part of the placeholder that the server-side filters
      // don't reach from here.
      const { dcs: allDcs } = await window.JKApi.dcs({ location: state.location.id });
      const q = (term || '').trim().toLowerCase();
      const matched = !q ? allDcs : allDcs.filter((dc) => {
        const hay = [dc.dc_no, dc.party, ...dc.lines.map((l) => l.item_name)].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
      const dcs = filter === 'all' ? matched : matched.filter((d) => d.direction === filter);
      countEl.textContent = `${dcs.length} logged`;
      if (!dcs.length) { listEl.innerHTML = `<div class="empty-state">No activity yet.</div>`; return; }
      listEl.innerHTML = dcs.map((dc) => {
        const first = dc.lines[0];
        const extra = dc.lines.length - 1;
        const line1 = first
          ? `<b>${JKFmt.qty(first.qty)} ${escapeHtml(first.unit)}</b> ${escapeHtml(first.item_name)}${extra > 0 ? ` + ${extra} more` : ''}`
          : '';
        const line2Base = dc.direction === 'out'
          ? `to ${escapeHtml(dc.party)}${dc.note ? ' · ' + escapeHtml(dc.note) : ''}`
          : (dc.note ? escapeHtml(dc.note) : 'Recorded');
        const line2 = line2Base + (dc.created_by_name ? ` · by ${escapeHtml(dc.created_by_name)}` : '') + (dc.edit_count ? ' · <span style="color:var(--accent);">edited</span>' : '');
        return `
        <a class="dc-row" href="/dc.html?id=${dc.id}" target="_blank">
          <div class="dc-dir ${dc.direction}">${dc.direction === 'in' ? '↓' : '↑'}</div>
          <div class="main">
            <div class="dc-line1">${line1}</div>
            <div class="dc-line2">${line2}</div>
          </div>
          <div class="dc-right">
            <div class="dc-no">${escapeHtml(dc.dc_no)}</div>
            <div class="dc-time">${JKFmt.dateTime(dc.created_at)}</div>
          </div>
        </a>
      `;
      }).join('');
    }
    el.querySelector('#dc-search').oninput = debounce((e) => load(e.target.value), 200);
    el.querySelector('#dc-filter').querySelectorAll('button').forEach((btn) => {
      btn.onclick = () => {
        filter = btn.dataset.val;
        el.querySelector('#dc-filter').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        load(el.querySelector('#dc-search').value);
      };
    });
    await load('');
  }

  // ---------------------------------------------------------------
  // Alerts view (low stock + threshold settings)
  // ---------------------------------------------------------------
  async function renderAlertsView(el) {
    el.innerHTML = `
      <div class="section-head"><h2>Low-stock alerts</h2><div class="meta">Set a threshold per item — you'll see it here once stock drops to or below it.</div></div>
      <div class="tree-table" id="alerts-list"><div class="loading-state">Loading…</div></div>
      <div class="section-head" style="margin-top:26px;"><h2>Set a threshold</h2></div>
      <div class="card card-pad">
        <div class="field">
          <label>Item</label>
          <select id="threshold-item"><option value="">Loading items…</option></select>
        </div>
        <div class="field">
          <label>Alert when stock is at or below</label>
          <input autocomplete="off" type="number" min="0" step="any" id="threshold-value" placeholder="e.g. 10" />
        </div>
        <button class="btn btn-primary" id="threshold-save">Save threshold</button>
      </div>
    `;
    const listEl = el.querySelector('#alerts-list');
    async function loadLow() {
      const { low_stock } = await window.JKApi.lowStock({ location: state.location.id });
      if (!low_stock.length) { listEl.innerHTML = `<div class="empty-state">Nothing below its alert threshold.</div>`; return; }
      listEl.innerHTML = low_stock.map((row) => `
        <div class="attn-row">
          <div><div class="name">${escapeHtml(row.item_name)}</div><div class="sub">alert set at ${JKFmt.qty(row.threshold)} ${escapeHtml(row.unit)} and below</div></div>
          <div class="spacer"></div>
          <div class="qty">${JKFmt.qty(row.qty)} <span style="font-weight:500; color:var(--ink-4); font-size:12.5px;">${escapeHtml(row.unit)}</span></div>
        </div>
      `).join('');
    }
    await loadLow();

    // Populate the item picker with every leaf across both tabs.
    const [{ items: materials }, { items: consumables }] = await Promise.all([
      window.JKApi.items({ kind: 'material', location: state.location.id }),
      window.JKApi.items({ kind: 'consumable', location: state.location.id }),
    ]);
    const leaves = [];
    (function collect(nodes) {
      nodes.forEach((n) => { if (n.isLeaf) leaves.push(n); else collect(n.children); });
    })([...materials, ...consumables]);
    const select = el.querySelector('#threshold-item');
    select.innerHTML = leaves.map((n) => `<option value="${n.id}">${escapeHtml(n.name)} (${escapeHtml(n.unit)})</option>`).join('');

    el.querySelector('#threshold-save').onclick = async () => {
      const itemId = select.value;
      const val = el.querySelector('#threshold-value').value;
      if (!itemId || val === '') { JKToast.error('Pick an item and a threshold.'); return; }
      try {
        await window.JKApi.setThreshold(itemId, Number(val), { location: state.location.id });
        JKToast.good('Threshold saved.');
        el.querySelector('#threshold-value').value = '';
        await loadLow();
      } catch (err) {
        JKToast.error(err.message);
      }
    };
  }

  // ---------------------------------------------------------------
  // Inventory book — a flat, searchable list of every item at this
  // location (not a dropdown); opening one shows its full-screen ledger
  // overlay. Replicated one-to-one from the mockup's book screens.
  // ---------------------------------------------------------------
  let bookLeaves = [];
  let bookSearch = '';

  async function renderBookView(el) {
    el.innerHTML = `
      <div class="section-head">
        <div>
          <h2>Inventory book</h2>
          <div class="meta" id="book-meta">Loading…</div>
        </div>
        <div class="spacer"></div>
        <button class="btn" id="book-back">&larr; Back to desk</button>
      </div>
      <div class="book-list" id="book-list">
        <div class="book-toolbar">
          <div class="search-pill">
            <span class="glyph">&#8981;</span>
            <input autocomplete="off" id="book-search" placeholder="Search any item" value="${escapeHtml(bookSearch)}" />
          </div>
        </div>
        <div id="book-rows"><div class="loading-state">Loading…</div></div>
      </div>
    `;
    el.querySelector('#book-back').onclick = () => { window.location.hash = ''; };

    const [{ items: materials }, { items: consumables }, { dcs }] = await Promise.all([
      window.JKApi.items({ kind: 'material', location: state.location.id }),
      window.JKApi.items({ kind: 'consumable', location: state.location.id }),
      window.JKApi.dcs({ location: state.location.id }),
    ]);
    bookLeaves = flattenLeavesWithPath([...materials, ...consumables]).sort((a, b) => a.node.name.localeCompare(b.node.name));

    // One item's inwards/outwards/DC-count at this location, aggregated
    // client-side from the DC list — same pattern as the DC wizard's item
    // picker, avoids an N+1 fetch per row.
    const moveByItem = {};
    dcs.forEach((dc) => {
      (dc.lines || []).forEach((l) => {
        const m = moveByItem[l.item_id] || (moveByItem[l.item_id] = { in: 0, out: 0, n: 0 });
        m.n += 1;
        if (dc.direction === 'in') m.in += Number(l.qty); else m.out += Number(l.qty);
      });
    });

    el.querySelector('#book-meta').textContent = `${bookLeaves.length} item${bookLeaves.length === 1 ? '' : 's'} at ${LOCATION_NAME} · open any item for its full DC history`;

    function renderRows() {
      const rowsEl = el.querySelector('#book-rows');
      if (!rowsEl) return;
      const q = bookSearch.trim().toLowerCase();
      const rows = bookLeaves.filter((e) => !q || (e.node.name + ' ' + e.breadcrumb).toLowerCase().includes(q));
      if (!rows.length) { rowsEl.innerHTML = `<div class="empty-state">No items match that search.</div>`; return; }
      rowsEl.innerHTML = `
        <div class="book-list-head">
          <div class="bkcol-name">Item</div>
          <div class="bkcol-onhand">On hand</div>
          <div class="bkcol-in">Inwards</div>
          <div class="bkcol-out">Outwards</div>
          <div class="bkcol-dcs">DCs</div>
        </div>
        ${rows.map((e) => {
          const qty = Number(e.node.qtyByLocation?.[state.location.id] || 0);
          const zero = qty <= 0;
          const mv = moveByItem[e.node.id] || { in: 0, out: 0, n: 0 };
          return `
            <button type="button" class="book-row" data-id="${e.node.id}">
              <span class="status-dot${zero ? ' bad' : ''}"></span>
              <span class="bkcol-name">
                <span class="item-name">${escapeHtml(e.node.name)}</span>
                <span class="item-crumb">${escapeHtml(e.breadcrumb || 'Top level')}</span>
              </span>
              <span class="bkcol-onhand${zero ? ' zero' : ''}"><span class="qty-num">${JKFmt.qty(qty)}</span><span class="unit"> ${escapeHtml(e.node.unit)}</span></span>
              <span class="bkcol-in">${mv.in ? '+' + JKFmt.qty(mv.in) : '&mdash;'}</span>
              <span class="bkcol-out">${mv.out ? '&minus;' + JKFmt.qty(mv.out) : '&mdash;'}</span>
              <span class="bkcol-dcs">${mv.n}</span>
            </button>
          `;
        }).join('')}
      `;
      rowsEl.querySelectorAll('.book-row').forEach((row) => {
        row.onclick = () => openBookLedger(row.dataset.id);
      });
    }
    renderRows();
    el.querySelector('#book-search').oninput = debounce((e) => { bookSearch = e.target.value; renderRows(); }, 150);
  }

  // Full-screen ledger overlay for one item — dark header with 4 stat
  // blocks, a bordered card with the opening balance / DC rows / closing
  // balance, mockup-exact.
  async function openBookLedger(itemId) {
    const entry = bookLeaves.find((e) => e.node.id === itemId);
    if (!entry) return;
    const item = entry.node;

    const overlay = document.createElement('div');
    overlay.className = 'bookov';
    overlay.innerHTML = `
      <div class="bookov-head">
        <div class="bookov-titles">
          <div class="bookov-eyebrow">Inventory book &middot; ${escapeHtml(LOCATION_NAME)}</div>
          <div class="bookov-name">${escapeHtml(item.name)}</div>
          <div class="bookov-crumb">${escapeHtml(entry.breadcrumb || 'Top level')}</div>
        </div>
        <div id="bookov-stats" style="display:flex; gap:20px; flex-wrap:wrap;"></div>
        <button type="button" class="bookov-close" id="bookov-close">Close</button>
      </div>
      <div class="bookov-body"><div class="bookov-card" id="bookov-card"><div class="loading-state">Loading…</div></div></div>
    `;
    document.body.appendChild(overlay);
    function close() { overlay.remove(); }
    overlay.querySelector('#bookov-close').onclick = close;

    const book = await window.JKApi.inventoryBooks({ item_id: itemId, location: state.location.id });
    const held = Number(book.closing_balance);
    const totalIn = book.entries.filter((e) => e.direction === 'in').reduce((s, e) => s + Number(e.qty), 0);
    const totalOut = book.entries.filter((e) => e.direction === 'out').reduce((s, e) => s + Number(e.qty), 0);

    overlay.querySelector('#bookov-stats').innerHTML = [
      { label: `on hand &middot; ${escapeHtml(item.unit)}`, value: JKFmt.qty(held), bad: held === 0 },
      { label: 'challans', value: JKFmt.qty(book.entries.length) },
      { label: 'inwards', value: JKFmt.qty(totalIn) },
      { label: 'outwards', value: JKFmt.qty(totalOut) },
    ].map((s) => `<div class="bookov-stat"><div class="value${s.bad ? ' bad' : ''}">${s.value}</div><div class="label">${s.label}</div></div>`).join('');

    const opening = Number(book.opening_balance);
    const short = opening < 0;
    const rows = book.entries.slice().reverse().map((e) => `
      <div class="bookov-row">
        <span class="c-date">${JKFmt.date(e.created_at)}</span>
        <span class="c-dcno">
          <span class="dc-badge ${e.direction}">${e.direction === 'in' ? '&#8595;' : '&#8593;'}</span>
          <span class="dc-no">${escapeHtml(e.dc_no)}</span>
        </span>
        <span class="c-part">
          <span class="party">${escapeHtml(e.direction === 'in' ? (e.party || 'Stock received') : (e.party || '&mdash;'))}</span>
          <span class="meta">${e.direction === 'in' ? 'Input DC' : 'Output DC'} &middot; ${JKFmt.dateTime(e.created_at).split(' · ')[1] || ''}</span>
        </span>
        <span class="c-in">${e.direction === 'in' ? JKFmt.qty(e.qty) : '&mdash;'}</span>
        <span class="c-out">${e.direction === 'out' ? JKFmt.qty(e.qty) : '&mdash;'}</span>
        <span class="c-bal">${JKFmt.qty(e.balance)}</span>
      </div>
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
        <span class="c-bal">${JKFmt.qty(opening)} ${escapeHtml(item.unit)}</span>
      </div>
      ${book.entries.length ? rows : `<div class="bookov-empty">No DC has ever touched this item.</div>`}
      <div class="bookov-crow">
        <span class="c-date"></span>
        <span class="c-dcno"></span>
        <span class="c-part">Closing balance</span>
        <span class="c-in">${JKFmt.qty(totalIn)}</span>
        <span class="c-out">${JKFmt.qty(totalOut)}</span>
        <span class="c-bal">${JKFmt.qty(held)} ${escapeHtml(item.unit)}</span>
      </div>
    `;
  }

  // ---------------------------------------------------------------
  // Input / Output DC wizard — a full-screen 3-step flow (Item ->
  // Quantity -> Note/Party&vehicle), matching the mockup exactly rather
  // than a single-page form: pick an item from a searchable, category-
  // grouped list, enter its quantity on a big numeric keypad with quick-add
  // chips, then review every line and supply the note (Input) or the
  // mandatory party/address/vehicle (Output) before recording.
  function flattenLeavesWithPath(nodes) {
    const out = [];
    (function walk(list, chain) {
      list.forEach((n) => {
        if (n.isLeaf) {
          out.push({ node: n, parentName: chain.length ? chain[chain.length - 1] : null, topName: chain.length ? chain[0] : n.name, breadcrumb: chain.join(' › ') });
        } else {
          walk(n.children, chain.concat(n.name));
        }
      });
    })(nodes, []);
    return out;
  }

  async function openDcWizard(direction, presetItemId) {
    const [{ items: materials }, { items: consumables }] = await Promise.all([
      window.JKApi.items({ kind: 'material', location: state.location.id }),
      window.JKApi.items({ kind: 'consumable', location: state.location.id }),
    ]);
    const leavesByKind = { material: flattenLeavesWithPath(materials), consumable: flattenLeavesWithPath(consumables) };
    const allEntries = [...leavesByKind.material, ...leavesByKind.consumable];
    function entryFor(id) { return allEntries.find((x) => x.node.id === id); }

    const isIn = direction === 'in';
    const accentVar = isIn ? 'var(--good)' : 'var(--accent)';

    const wiz = {
      step: presetItemId ? 'qty' : 'item',
      kindTab: (presetItemId && entryFor(presetItemId)?.node.kind) || 'material',
      search: '',
      lines: [],
      current: { item_id: presetItemId || null, qty: '' },
      party: '', vehicle_no: '', address: '', note: '',
    };

    const overlay = document.createElement('div');
    overlay.className = 'dcwiz';
    overlay.id = 'active-dc-wizard';
    document.body.appendChild(overlay);

    function close() { overlay.remove(); }
    function stepIndex() { return wiz.step === 'item' ? 0 : wiz.step === 'qty' ? 1 : 2; }
    function commitCurrentLine() {
      if (wiz.current.item_id && Number(wiz.current.qty) > 0) {
        wiz.lines.push({ item_id: wiz.current.item_id, qty: Number(wiz.current.qty) });
        wiz.current = { item_id: null, qty: '' };
        return true;
      }
      return false;
    }
    function finalIsValid() {
      if (!wiz.lines.length) return false;
      return isIn || (wiz.party.trim() && wiz.address.trim() && wiz.vehicle_no.trim());
    }
    function computeHint() {
      const totalQty = wiz.lines.reduce((s, l) => s + Number(l.qty), 0);
      if (isIn) return `${wiz.lines.length} item${wiz.lines.length === 1 ? '' : 's'} · ${JKFmt.qty(totalQty)} units into ${state.location.name} on one DC. A note is optional.`;
      if (!wiz.party.trim()) return 'Enter the party name.';
      if (!wiz.address.trim()) return 'Enter the delivery address.';
      if (!wiz.vehicle_no.trim()) return 'Enter the vehicle number.';
      return `${wiz.lines.length} item${wiz.lines.length === 1 ? '' : 's'} · ${JKFmt.qty(totalQty)} units leaving ${state.location.name} on one DC.`;
    }

    function render() {
      overlay.innerHTML = `
        <div class="dcwiz-head">
          <div class="dcwiz-head-inner">
            <span class="dcwiz-icon ${isIn ? 'in' : 'out'}">${isIn ? '&#8595;' : '&#8593;'}</span>
            <span class="dcwiz-titles">
              <span class="dcwiz-title">${isIn ? 'Input DC' : 'Output DC'}</span>
              <span class="dcwiz-subtitle">${isIn ? 'Arriving at' : 'Leaving'} ${escapeHtml(state.location.name)}</span>
            </span>
            <button type="button" class="dcwiz-close" id="dcwiz-close">&times;</button>
          </div>
          <div class="dcwiz-progress">
            ${['Item', 'Quantity', isIn ? 'Note' : 'Party & vehicle'].map((label, i) => `
              <div class="dcwiz-seg">
                <div class="dcwiz-seg-bar" style="background:${i <= stepIndex() ? accentVar : 'var(--border-2)'}"></div>
                <div class="dcwiz-seg-label">${label}</div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="dcwiz-body"><div class="dcwiz-body-inner">
          ${wiz.step === 'item' ? renderItemStep() : wiz.step === 'qty' ? renderQtyStep() : renderFinalStep()}
        </div></div>
        <div class="dcwiz-foot">${renderFoot()}</div>
      `;
      wire();
    }

    function renderItemStep() {
      return `
        <input autocomplete="off" class="dcwiz-search" id="dcwiz-search" placeholder="Type to narrow the list" value="${escapeHtml(wiz.search)}" />
        <div class="dcwiz-tabs">
          <button type="button" class="dcwiz-tab ${wiz.kindTab === 'material' ? 'active' : ''}" data-kind="material">Materials</button>
          <button type="button" class="dcwiz-tab ${wiz.kindTab === 'consumable' ? 'active' : ''}" data-kind="consumable">Consumables</button>
        </div>
        <div id="dcwiz-item-list">${renderItemListHtml()}</div>
      `;
    }

    function renderItemListHtml() {
      const entries = leavesByKind[wiz.kindTab];
      const q = wiz.search.trim().toLowerCase();
      const filtered = q ? entries.filter((x) => x.node.name.toLowerCase().includes(q)) : entries;
      const groups = [];
      filtered.forEach((x) => {
        let g = groups.find((g) => g.parentName === x.parentName);
        if (!g) { g = { parentName: x.parentName, topName: x.topName, items: [] }; groups.push(g); }
        g.items.push(x);
      });
      if (!groups.length) return `<div class="empty-state">No items found.</div>`;
      return groups.map((g) => `
        <div class="dcwiz-group">
          <div class="dcwiz-group-head">
            <span class="name">${escapeHtml(g.parentName || g.topName)}</span>
            ${g.parentName && g.parentName !== g.topName ? `<span class="top">${escapeHtml(g.topName)}</span>` : ''}
            <span class="spacer"></span>
            <span class="count">${g.items.length} item${g.items.length === 1 ? '' : 's'}</span>
          </div>
          ${g.items.map((x) => `
            <button type="button" class="dcwiz-item-row" data-id="${x.node.id}">
              <span class="name">${escapeHtml(x.node.name)}</span>
              <span class="qty">${JKFmt.qty(x.node.qtyByLocation?.[state.location.id] || 0)}<span class="unit"> ${escapeHtml(x.node.unit)}</span></span>
            </button>
          `).join('')}
        </div>
      `).join('');
    }

    function renderQtyStep() {
      const entry = entryFor(wiz.current.item_id);
      const onHand = Number(entry?.node.qtyByLocation?.[state.location.id] || 0);
      const q = wiz.current.qty === '' ? 0 : Number(wiz.current.qty);
      const after = Math.max(isIn ? onHand + q : onHand - q, 0);
      return `
        <div class="dcwiz-selected-card">
          <span class="name">${escapeHtml(entry?.node.name || '')}</span>
          <span class="crumb">${escapeHtml(entry?.breadcrumb || '')}</span>
        </div>
        <div class="dcwiz-keypad-display">
          <div class="num">${wiz.current.qty === '' ? '0' : escapeHtml(wiz.current.qty)}</div>
          <div class="unit">${escapeHtml(entry?.node.unit || '')}</div>
        </div>
        <div class="dcwiz-chips">
          ${[5, 10, 25, 50].map((n) => `<button type="button" class="dcwiz-chip" data-add="${n}">+${n}</button>`).join('')}
          <button type="button" class="dcwiz-chip" data-clear="1">Clear</button>
        </div>
        <div class="dcwiz-keypad">
          ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'].map((k) => `
            <button type="button" class="dcwiz-key${k === 'back' ? ' back' : ''}" data-key="${k}">${k === 'back' ? '&#9003;' : k}</button>
          `).join('')}
        </div>
        <div class="dcwiz-hint">On hand ${JKFmt.qty(onHand)} ${escapeHtml(entry?.node.unit || '')} &rarr; ${JKFmt.qty(after)} after this DC.</div>
      `;
    }

    function renderFinalStep() {
      const linesHtml = wiz.lines.length ? wiz.lines.map((l, i) => {
        const entry = entryFor(l.item_id);
        return `
          <div class="dcwiz-line-row">
            <span class="info"><span class="name">${escapeHtml(entry?.node.name || '')}</span><span class="crumb">${escapeHtml(entry?.breadcrumb || '')}</span></span>
            <span class="qty">${JKFmt.qty(l.qty)}</span>
            <span class="unit">${escapeHtml(entry?.node.unit || '')}</span>
            <button type="button" class="dcwiz-line-remove" data-i="${i}" title="Remove">&times;</button>
          </div>
        `;
      }).join('') : '';
      return `
        <div class="dcwiz-lines-card">
          <div class="dcwiz-lines-head"><span>On this DC</span><span class="count">${wiz.lines.length} item${wiz.lines.length === 1 ? '' : 's'}</span></div>
          ${linesHtml}
          <button type="button" class="dcwiz-add-more" id="dcwiz-add-more">+ Add another item</button>
        </div>
        ${isIn ? `
          <div class="dcwiz-field">
            <label>Note — optional</label>
            <input autocomplete="off" id="dcwiz-note" placeholder="Anything worth recording on this DC" value="${escapeHtml(wiz.note)}" />
          </div>
        ` : `
          <div class="dcwiz-field">
            <label>Party name — who it is going to</label>
            <input autocomplete="off" id="dcwiz-party" placeholder="Customer or party name" value="${escapeHtml(wiz.party)}" style="${wiz.party.trim() ? '' : 'border-color:var(--bad-border);'}" />
          </div>
          <div class="dcwiz-field">
            <label>Delivery address</label>
            <input autocomplete="off" id="dcwiz-address" placeholder="Where the material is going" value="${escapeHtml(wiz.address)}" style="${wiz.address.trim() ? '' : 'border-color:var(--bad-border);'}" />
          </div>
          <div class="dcwiz-field">
            <label>Vehicle number</label>
            <input autocomplete="off" id="dcwiz-vehicle" placeholder="e.g. HR 26 AT 4412" value="${escapeHtml(wiz.vehicle_no)}" style="text-transform:uppercase; letter-spacing:.04em; ${wiz.vehicle_no.trim() ? '' : 'border-color:var(--bad-border);'}" />
          </div>
        `}
        <div class="dcwiz-hintbox">${escapeHtml(computeHint())}</div>
      `;
    }

    function renderFoot() {
      if (wiz.step === 'item') {
        return `<button type="button" class="dcwiz-cta" disabled>Choose an item</button>`;
      }
      if (wiz.step === 'qty') {
        const valid = wiz.current.item_id && Number(wiz.current.qty) > 0;
        return `
          <button type="button" class="dcwiz-back" id="dcwiz-back">Back</button>
          <button type="button" class="dcwiz-plusitem" id="dcwiz-plusitem" ${valid ? '' : 'disabled'}>+ Item</button>
          <button type="button" class="dcwiz-cta ${valid ? 'active' : ''}" id="dcwiz-continue" ${valid ? '' : 'disabled'} style="${valid ? `background:${accentVar}; border-color:${accentVar};` : ''}">${valid ? 'Continue' : 'Enter a quantity'}</button>
        `;
      }
      const valid = finalIsValid();
      return `
        <button type="button" class="dcwiz-back" id="dcwiz-back">Back</button>
        <button type="button" class="dcwiz-cta ${valid ? 'active' : ''}" id="dcwiz-submit" ${valid ? '' : 'disabled'} style="${valid ? `background:${accentVar}; border-color:${accentVar};` : ''}">${isIn ? 'Record Input DC' : 'Record Output DC'}</button>
      `;
    }

    function wire() {
      overlay.querySelector('#dcwiz-close').onclick = close;

      if (wiz.step === 'item') {
        const searchEl = overlay.querySelector('#dcwiz-search');
        searchEl.oninput = debounce((e) => {
          wiz.search = e.target.value;
          overlay.querySelector('#dcwiz-item-list').innerHTML = renderItemListHtml();
          wireItemList();
        }, 120);
        overlay.querySelectorAll('.dcwiz-tab').forEach((b) => { b.onclick = () => { wiz.kindTab = b.dataset.kind; render(); }; });
        wireItemList();
      }

      if (wiz.step === 'qty') {
        overlay.querySelector('#dcwiz-back').onclick = () => { wiz.step = 'item'; render(); };
        overlay.querySelectorAll('.dcwiz-chip').forEach((b) => {
          b.onclick = () => {
            if (b.dataset.clear) wiz.current.qty = '';
            else wiz.current.qty = String((Number(wiz.current.qty) || 0) + Number(b.dataset.add));
            render();
          };
        });
        overlay.querySelectorAll('.dcwiz-key').forEach((b) => {
          b.onclick = () => {
            const k = b.dataset.key;
            if (k === 'back') wiz.current.qty = wiz.current.qty.slice(0, -1);
            else if (k === '.') { if (!wiz.current.qty.includes('.')) wiz.current.qty += '.'; }
            else wiz.current.qty = (wiz.current.qty === '0' ? '' : wiz.current.qty) + k;
            render();
          };
        });
        const plusBtn = overlay.querySelector('#dcwiz-plusitem');
        if (plusBtn) plusBtn.onclick = () => { commitCurrentLine(); wiz.step = 'item'; render(); };
        const contBtn = overlay.querySelector('#dcwiz-continue');
        if (contBtn) contBtn.onclick = () => { commitCurrentLine(); wiz.step = 'final'; render(); };
      }

      if (wiz.step === 'final') {
        overlay.querySelector('#dcwiz-back').onclick = () => { wiz.step = 'qty'; wiz.current = { item_id: null, qty: '' }; render(); };
        overlay.querySelector('#dcwiz-add-more').onclick = () => { wiz.step = 'item'; render(); };
        overlay.querySelectorAll('.dcwiz-line-remove').forEach((b) => {
          b.onclick = () => { wiz.lines.splice(Number(b.dataset.i), 1); render(); };
        });
        wireFinalInputs();
        const submitBtn = overlay.querySelector('#dcwiz-submit');
        submitBtn.onclick = async () => {
          if (!finalIsValid()) return;
          submitBtn.disabled = true;
          submitBtn.textContent = 'Recording…';
          try {
            const { dc } = await window.JKApi.recordDc({
              direction,
              party: isIn ? undefined : wiz.party.trim(),
              vehicle_no: wiz.vehicle_no || undefined,
              address: wiz.address || undefined,
              note: wiz.note || undefined,
              lines: wiz.lines.map((l) => ({ item_id: l.item_id, qty: l.qty })),
            }, { location: state.location.id });
            close();
            JKToast.good(`${dc.dc_no} recorded.`);
            await loadTree();
            renderTreeBody();
          } catch (err) {
            JKToast.error(err.message);
            submitBtn.disabled = false;
            submitBtn.textContent = isIn ? 'Record Input DC' : 'Record Output DC';
          }
        };
      }
    }

    function wireItemList() {
      overlay.querySelectorAll('.dcwiz-item-row').forEach((b) => {
        b.onclick = () => { wiz.current = { item_id: b.dataset.id, qty: '' }; wiz.step = 'qty'; render(); };
      });
    }

    function wireFinalInputs() {
      const hintEl = overlay.querySelector('.dcwiz-hintbox');
      const submitBtn = overlay.querySelector('#dcwiz-submit');
      function refresh() {
        const valid = finalIsValid();
        submitBtn.disabled = !valid;
        submitBtn.classList.toggle('active', valid);
        submitBtn.style.background = valid ? accentVar : '';
        submitBtn.style.borderColor = valid ? accentVar : '';
        hintEl.textContent = computeHint();
        if (!isIn) {
          ['party', 'address', 'vehicle_no'].forEach((key) => {
            const el = overlay.querySelector(`#dcwiz-${key === 'vehicle_no' ? 'vehicle' : key}`);
            if (el) el.style.borderColor = wiz[key].trim() ? 'var(--border)' : 'var(--bad-border)';
          });
        }
      }
      if (isIn) {
        overlay.querySelector('#dcwiz-note').oninput = (e) => { wiz.note = e.target.value; };
      } else {
        overlay.querySelector('#dcwiz-party').oninput = (e) => { wiz.party = e.target.value; refresh(); };
        overlay.querySelector('#dcwiz-address').oninput = (e) => { wiz.address = e.target.value; refresh(); };
        overlay.querySelector('#dcwiz-vehicle').oninput = (e) => { wiz.vehicle_no = e.target.value; refresh(); };
      }
    }

    render();
  }

  // ---------------------------------------------------------------
  // Modal helper
  // ---------------------------------------------------------------
  function openModal(title, bodyHtml, buttons) {
    closeModal();
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    scrim.id = 'active-modal';
    scrim.innerHTML = `
      <div class="modal">
        <div class="modal-head"><div class="title">${escapeHtml(title)}</div>
          <button class="btn btn-ghost icon" id="modal-close">&times;</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-foot">${buttons.map((b, i) => `<button class="btn ${b.primary ? 'btn-primary' : ''}" data-i="${i}">${escapeHtml(b.label)}</button>`).join('')}</div>
      </div>
    `;
    document.body.appendChild(scrim);
    scrim.querySelector('#modal-close').onclick = () => closeModal();
    scrim.addEventListener('click', (e) => { if (e.target === scrim) closeModal(); });
    buttons.forEach((b, i) => {
      scrim.querySelectorAll('.modal-foot .btn')[i].onclick = (e) => b.onClick(e.target);
    });
    return scrim;
  }
  function closeModal() {
    document.getElementById('active-modal')?.remove();
  }

  // ---------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  boot();
})();
