// Shared Input/Output DC wizard — a full-screen 3-step flow (Item ->
// Quantity -> Note/Party & vehicle). Originally lived only in
// location-desk.js (Fabrication/Finished, always the signed-in operator's
// own location); extracted here so Admin can record a DC too, at whichever
// location their drill-in screen is currently showing — the backend
// already supported this (resolveLocationId in src/middleware/auth.js lets
// admin pass any location_id), this was purely a missing-UI gap.
//
// window.JKDcWizard.open({ direction: 'in'|'out', presetItemId?, location: { id, name }, onRecorded?: async () => {} })
window.JKDcWizard = (function () {
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

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

  async function open(opts) {
    const { direction, presetItemId, location, onRecorded } = opts;

    const [{ items: materials }, { items: consumables }] = await Promise.all([
      window.JKApi.items({ kind: 'material', location: location.id }),
      window.JKApi.items({ kind: 'consumable', location: location.id }),
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
      if (isIn) return `${wiz.lines.length} item${wiz.lines.length === 1 ? '' : 's'} · ${JKFmt.qty(totalQty)} units into ${location.name} on one DC. A note is optional.`;
      if (!wiz.party.trim()) return 'Enter the party name.';
      if (!wiz.address.trim()) return 'Enter the delivery address.';
      if (!wiz.vehicle_no.trim()) return 'Enter the vehicle number.';
      return `${wiz.lines.length} item${wiz.lines.length === 1 ? '' : 's'} · ${JKFmt.qty(totalQty)} units leaving ${location.name} on one DC.`;
    }

    function render() {
      overlay.innerHTML = `
        <div class="dcwiz-head">
          <div class="dcwiz-head-inner">
            <span class="dcwiz-icon ${isIn ? 'in' : 'out'}">${isIn ? '&#8595;' : '&#8593;'}</span>
            <span class="dcwiz-titles">
              <span class="dcwiz-title">${isIn ? 'Input DC' : 'Output DC'}</span>
              <span class="dcwiz-subtitle">${isIn ? 'Arriving at' : 'Leaving'} ${escapeHtml(location.name)}</span>
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
              <span class="qty">${JKFmt.qty(x.node.qtyByLocation?.[location.id] || 0)}<span class="unit"> ${escapeHtml(x.node.unit)}</span></span>
            </button>
          `).join('')}
        </div>
      `).join('');
    }

    function renderQtyStep() {
      const entry = entryFor(wiz.current.item_id);
      const onHand = Number(entry?.node.qtyByLocation?.[location.id] || 0);
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
            }, { location: location.id });
            close();
            JKToast.good(`${dc.dc_no} recorded.`);
            if (onRecorded) await onRecorded();
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

  return { open };
})();
