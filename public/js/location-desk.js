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
    view: 'tree', // 'tree' | 'activity' | 'alerts' | 'book'
    bookItem: null,
  };

  const root = document.getElementById('app');

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
    } else if (hash === 'activity' || hash === 'alerts') {
      state.view = hash;
    } else {
      state.view = 'tree';
    }
    render();
  }

  // ---------------------------------------------------------------
  // Render shell
  // ---------------------------------------------------------------
  async function render() {
    let outOfStock = 0;
    try { const r = await window.JKApi.lowStock({ location: state.location.id }); outOfStock = (r.low_stock || []).filter((x) => Number(x.qty) <= 0).length; } catch (e) {}

    root.innerHTML = `
      <header class="topbar">
        ${window.JKUi.logoMarkHtml()}
        <div class="divider"></div>
        <div class="context">
          <div class="eyebrow">Stock at</div>
          <div class="title">${escapeHtml(LOCATION_NAME)}</div>
        </div>
        <div class="spacer"></div>
        <span class="status-pill"><span class="dot dot-good"></span>${escapeHtml(OTHER_NAME)} keeps its own stock</span>
        <button class="btn" id="btn-book-nav">Inventory book</button>
        ${outOfStock > 0 ? `<button class="badge-out" id="btn-alerts-nav">${outOfStock} out of stock</button>` : `<button class="btn" id="btn-alerts-nav">Alerts</button>`}
        <button class="btn-gear" id="btn-settings" title="Settings">&#9881;</button>
        <button class="btn icon" id="btn-signout" title="Sign out">&#8594;</button>
      </header>
      <div class="page" id="view-root"></div>
    `;
    document.getElementById('btn-book-nav').onclick = () => { window.location.hash = 'activity'; };
    document.getElementById('btn-alerts-nav').onclick = () => { window.location.hash = 'alerts'; };
    document.getElementById('btn-signout').onclick = () => window.JKAuth.signOut();
    document.getElementById('btn-settings').onclick = () => {
      window.JKUi.openSettingsModal({
        lowStockThreshold: state.location?.default_threshold,
        lowStockCount: outOfStock,
        onChange: (p) => { state.expanded.clear(); if (p.expandDefault) state._expandAll = true; else state._expandAll = false; if (state.view === 'tree') renderTreeBody(); },
      });
    };

    const viewRoot = document.getElementById('view-root');
    if (state.view === 'tree') return renderTreeView(viewRoot);
    if (state.view === 'activity') return renderActivityView(viewRoot);
    if (state.view === 'alerts') return renderAlertsView(viewRoot);
    if (state.view === 'book') return renderBookView(viewRoot);
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
          <input class="search-input" id="search" placeholder="Search items" value="${escapeHtml(state.search)}" />
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
          <div class="search-pill">&#8981;<input id="dc-search" placeholder="Search DC no. / item / party" /></div>
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
      const { dcs: allDcs } = await window.JKApi.dcs({ location: state.location.id, dc_no: term, party: term });
      const dcs = filter === 'all' ? allDcs : allDcs.filter((d) => d.direction === filter);
      countEl.textContent = `${dcs.length} logged`;
      if (!dcs.length) { listEl.innerHTML = `<div class="empty-state">No activity yet.</div>`; return; }
      listEl.innerHTML = dcs.map((dc) => {
        const first = dc.lines[0];
        const extra = dc.lines.length - 1;
        const line1 = first
          ? `<b>${JKFmt.qty(first.qty)} ${escapeHtml(first.unit)}</b> ${escapeHtml(first.item_name)}${extra > 0 ? ` + ${extra} more` : ''}`
          : '';
        const line2 = dc.direction === 'out'
          ? `to ${escapeHtml(dc.party)}${dc.note ? ' · ' + escapeHtml(dc.note) : ''}`
          : `${escapeHtml(dc.party)}${dc.vehicle_no ? ' · ' + escapeHtml(dc.vehicle_no) : ''}`;
        return `
        <div class="dc-row" data-id="${dc.id}">
          <div class="dc-dir ${dc.direction}">${dc.direction === 'in' ? '↓' : '↑'}</div>
          <div class="main">
            <div class="dc-line1">${line1}</div>
            <div class="dc-line2">${line2}</div>
          </div>
          <div class="dc-right">
            <div class="dc-no">${escapeHtml(dc.dc_no)}</div>
            <div class="dc-time">${JKFmt.dateTime(dc.created_at)}</div>
          </div>
        </div>
      `;
      }).join('');
      listEl.querySelectorAll('.dc-row').forEach((row) => {
        row.onclick = () => openDcDocument(row.dataset.id);
      });
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
          <input type="number" min="0" step="any" id="threshold-value" placeholder="e.g. 10" />
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
  // Inventory book view (per item ledger)
  // ---------------------------------------------------------------
  async function renderBookView(el) {
    el.innerHTML = `
      <div class="section-head">
        <h2>Inventory book</h2>
        <div class="spacer"></div>
        <select id="book-item-select" style="min-width:260px;"><option>Loading…</option></select>
      </div>
      <div id="book-content"><div class="loading-state">Loading…</div></div>
    `;
    const [{ items: materials }, { items: consumables }] = await Promise.all([
      window.JKApi.items({ kind: 'material', location: state.location.id }),
      window.JKApi.items({ kind: 'consumable', location: state.location.id }),
    ]);
    const leaves = [];
    (function collect(nodes) {
      nodes.forEach((n) => { if (n.isLeaf) leaves.push(n); else collect(n.children); });
    })([...materials, ...consumables]);

    const select = el.querySelector('#book-item-select');
    select.innerHTML = leaves.map((n) => `<option value="${n.id}">${escapeHtml(n.name)}</option>`).join('');
    const initial = state.bookItem && leaves.find((n) => n.id === state.bookItem) ? state.bookItem : leaves[0]?.id;
    if (initial) select.value = initial;

    async function loadBook(itemId) {
      const content = el.querySelector('#book-content');
      if (!itemId) { content.innerHTML = `<div class="empty-state">No items yet.</div>`; return; }
      content.innerHTML = `<div class="loading-state">Loading…</div>`;
      const book = await window.JKApi.inventoryBooks({ item_id: itemId, location: state.location.id });
      const item = leaves.find((n) => n.id === itemId);
      const rows = [`
        <div class="tree-row parent"><div class="col-name">Opening balance</div><div class="col-qty">${JKFmt.qty(book.opening_balance)} ${escapeHtml(item?.unit || '')}</div></div>
      `];
      book.entries.forEach((e) => {
        rows.push(`
          <div class="dc-row">
            <div class="dc-dir ${e.direction}">${e.direction === 'in' ? '↓' : '↑'}</div>
            <div class="main">
              <div class="dc-no">${escapeHtml(e.dc_no)} &middot; ${escapeHtml(e.party)}</div>
              <div class="dc-sub">${e.direction === 'in' ? '+' : '-'}${JKFmt.qty(e.qty)} ${escapeHtml(item?.unit || '')} &middot; balance ${JKFmt.qty(e.balance)}</div>
            </div>
            <div class="dc-time">${JKFmt.dateTime(e.created_at)}</div>
          </div>
        `);
      });
      rows.push(`
        <div class="tree-row parent"><div class="col-name">Closing balance</div><div class="col-qty">${JKFmt.qty(book.closing_balance)} ${escapeHtml(item?.unit || '')}</div></div>
      `);
      content.innerHTML = `<div class="tree-table">${rows.join('')}</div>`;
    }

    select.onchange = () => loadBook(select.value);
    await loadBook(initial);
  }

  // ---------------------------------------------------------------
  // DC document (read-only view of one DC)
  // ---------------------------------------------------------------
  async function openDcDocument(dcId) {
    const { dc } = await window.JKApi.dc(dcId);
    const modal = openModal(`DC ${dc.dc_no}`, `
      <div class="field"><label>Direction</label><div>${dc.direction === 'in' ? 'Input DC' : 'Output DC'}</div></div>
      <div class="field"><label>Party</label><div>${escapeHtml(dc.party)}</div></div>
      ${dc.vehicle_no ? `<div class="field"><label>Vehicle</label><div>${escapeHtml(dc.vehicle_no)}</div></div>` : ''}
      ${dc.address ? `<div class="field"><label>Address</label><div>${escapeHtml(dc.address)}</div></div>` : ''}
      ${dc.note ? `<div class="field"><label>Note</label><div>${escapeHtml(dc.note)}</div></div>` : ''}
      <div class="field"><label>Date</label><div>${JKFmt.dateTime(dc.created_at)}</div></div>
      <div class="field"><label>Lines</label>
        <div class="tree-table">
          ${dc.lines.map((l) => `
            <div class="tree-row leaf"><div class="col-name">${escapeHtml(l.item_name)}</div><div class="col-qty">${JKFmt.qty(l.qty)} ${escapeHtml(l.unit)}</div></div>
          `).join('')}
        </div>
      </div>
    `, [{ label: 'Close', primary: true, onClick: () => closeModal() }]);
  }

  // ---------------------------------------------------------------
  // Input / Output DC wizard
  // ---------------------------------------------------------------
  function flattenLeaves(nodes, kind) {
    const out = [];
    (function walk(list) {
      list.forEach((n) => { if (n.isLeaf) out.push(n); else walk(n.children); });
    })(nodes);
    return out;
  }

  async function openDcWizard(direction, presetItemId) {
    const [{ items: materials }, { items: consumables }] = await Promise.all([
      window.JKApi.items({ kind: 'material', location: state.location.id }),
      window.JKApi.items({ kind: 'consumable', location: state.location.id }),
    ]);
    const leaves = [...flattenLeaves(materials), ...flattenLeaves(consumables)];

    const wiz = {
      direction,
      lines: [],
      party: direction === 'out' ? '' : '',
      vehicle_no: '',
      address: '',
      note: '',
    };
    if (presetItemId) wiz.lines.push({ item_id: presetItemId, qty: '' });

    function itemName(id) { return leaves.find((n) => n.id === id)?.name || ''; }
    function itemUnit(id) { return leaves.find((n) => n.id === id)?.unit || ''; }
    function itemQty(id) { return Number(leaves.find((n) => n.id === id)?.qtyByLocation?.[state.location.id] || 0); }

    function linesHtml() {
      if (!wiz.lines.length) return `<div class="hint">No items added yet.</div>`;
      return wiz.lines.map((line, i) => `
        <div class="line-row">
          <select data-i="${i}" class="line-item">
            <option value="">Choose item…</option>
            ${leaves.map((n) => `<option value="${n.id}" ${n.id === line.item_id ? 'selected' : ''}>${escapeHtml(n.name)} (${escapeHtml(n.unit)}${direction === 'out' ? ', ' + JKFmt.qty(n.qtyByLocation?.[state.location.id] || 0) + ' on hand' : ''})</option>`).join('')}
          </select>
          <input type="number" min="0" step="any" data-i="${i}" class="line-qty" placeholder="Qty" value="${line.qty}" />
          <button type="button" class="btn btn-ghost icon line-remove" data-i="${i}">&times;</button>
        </div>
      `).join('');
    }

    function bodyHtml() {
      return `
        <div class="field">
          <label>${direction === 'in' ? 'Items arriving' : 'Items leaving'}</label>
          <div id="lines-wrap">${linesHtml()}</div>
          <button type="button" class="btn btn-sm" id="add-line">+ Add another item</button>
        </div>
        <div class="field">
          <label>${direction === 'in' ? 'From (party)' : 'To (party)'}</label>
          <input id="w-party" list="party-suggest" placeholder="${direction === 'out' ? `${OTHER_NAME}, or a customer name` : 'Supplier name'}" value="${escapeHtml(wiz.party)}" />
          <datalist id="party-suggest"><option value="${escapeHtml(OTHER_NAME)}"></option></datalist>
        </div>
        ${direction === 'out' ? `
        <div class="field"><label>Vehicle no. (optional)</label><input id="w-vehicle" value="${escapeHtml(wiz.vehicle_no)}" /></div>
        <div class="field"><label>Address (optional)</label><input id="w-address" value="${escapeHtml(wiz.address)}" /></div>
        ` : ''}
        <div class="field"><label>Note (optional)</label><textarea id="w-note" rows="2">${escapeHtml(wiz.note)}</textarea></div>
        <div class="field error hidden" id="w-error"></div>
      `;
    }

    function wireBody(bodyEl) {
      bodyEl.querySelector('#add-line').onclick = () => {
        wiz.lines.push({ item_id: '', qty: '' });
        bodyEl.querySelector('#lines-wrap').innerHTML = linesHtml();
        wireLines(bodyEl);
      };
      wireLines(bodyEl);
      bodyEl.querySelector('#w-party').oninput = (e) => { wiz.party = e.target.value; };
      const vehicleEl = bodyEl.querySelector('#w-vehicle');
      if (vehicleEl) vehicleEl.oninput = (e) => { wiz.vehicle_no = e.target.value; };
      const addressEl = bodyEl.querySelector('#w-address');
      if (addressEl) addressEl.oninput = (e) => { wiz.address = e.target.value; };
      bodyEl.querySelector('#w-note').oninput = (e) => { wiz.note = e.target.value; };
    }

    function wireLines(bodyEl) {
      bodyEl.querySelectorAll('.line-item').forEach((sel) => {
        sel.onchange = () => { wiz.lines[Number(sel.dataset.i)].item_id = sel.value; };
      });
      bodyEl.querySelectorAll('.line-qty').forEach((inp) => {
        inp.oninput = () => { wiz.lines[Number(inp.dataset.i)].qty = inp.value; };
      });
      bodyEl.querySelectorAll('.line-remove').forEach((btn) => {
        btn.onclick = () => {
          wiz.lines.splice(Number(btn.dataset.i), 1);
          bodyEl.querySelector('#lines-wrap').innerHTML = linesHtml();
          wireLines(bodyEl);
        };
      });
    }

    const modal = openModal(
      direction === 'in' ? 'Input DC' : 'Output DC',
      bodyHtml(),
      [
        { label: 'Cancel', onClick: () => closeModal() },
        {
          label: direction === 'in' ? 'Record Input DC' : 'Record Output DC',
          primary: true,
          onClick: async (footBtn) => {
            const errorEl = document.getElementById('w-error');
            errorEl.classList.add('hidden');
            const cleanLines = wiz.lines
              .filter((l) => l.item_id && Number(l.qty) > 0)
              .map((l) => ({ item_id: l.item_id, qty: Number(l.qty) }));
            if (!cleanLines.length) {
              errorEl.textContent = 'Add at least one item with a quantity.';
              errorEl.classList.remove('hidden');
              return;
            }
            if (!wiz.party.trim()) {
              errorEl.textContent = direction === 'in' ? 'Who is this arriving from?' : 'Who is this going to?';
              errorEl.classList.remove('hidden');
              return;
            }
            footBtn.disabled = true;
            footBtn.textContent = 'Recording…';
            try {
              const { dc } = await window.JKApi.recordDc({
                direction,
                party: wiz.party.trim(),
                vehicle_no: wiz.vehicle_no || undefined,
                address: wiz.address || undefined,
                note: wiz.note || undefined,
                lines: cleanLines,
              }, { location: state.location.id });
              closeModal();
              JKToast.good(`${dc.dc_no} recorded.`);
              await loadTree();
              renderTreeBody();
            } catch (err) {
              errorEl.textContent = err.message;
              errorEl.classList.remove('hidden');
              footBtn.disabled = false;
              footBtn.textContent = direction === 'in' ? 'Record Input DC' : 'Record Output DC';
            }
          },
        },
      ]
    );
    wireBody(document.querySelector('.modal-body'));
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
