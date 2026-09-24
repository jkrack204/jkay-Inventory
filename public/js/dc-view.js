// DC document page — public/dc.html?id=<uuid>. Stores nothing itself; just
// re-fetches and re-renders whatever /api/dc/:id returns, so the same URL
// always opens the DC's current, live state — "store it and open it back
// up when needed."
//
// Also hosts the correction flow: the creator can edit within the 24h
// buffer, admin can edit anytime and choose whether the edit moves stock,
// and every edit is logged (admin can expand the history panel to see it).

(function () {
  const params = new URLSearchParams(window.location.search);
  const dcId = params.get('id');
  const root = document.getElementById('app');
  let dc = null;
  let user = null;
  let editing = false;

  async function boot() {
    const session = await window.JKAuth.requireSession();
    if (!session) return;
    if (!dcId) {
      root.innerHTML = `<div class="empty-state">No DC id given.</div>`;
      return;
    }
    try {
      const [{ user: u }] = await Promise.all([window.JKApi.me()]);
      user = u;
      await load();
    } catch (err) {
      root.innerHTML = `<div class="empty-state">Could not load this DC — ${esc(err.message)}</div>`;
    }
  }

  async function load() {
    const { dc: fresh } = await window.JKApi.dc(dcId);
    dc = fresh;
    editing = false;
    render();
  }

  function backHref() {
    // Same-origin referrer wins (came from Activity/DC log); otherwise send
    // admin to the admin home and everyone else to their own desk.
    if (document.referrer && document.referrer.startsWith(window.location.origin)) return document.referrer;
    return user?.role === 'admin' ? '/admin.html' : '/';
  }

  function render() {
    if (!dc) return;
    const isAdmin = user.role === 'admin';
    root.innerHTML = `
      <div class="dc-toolbar">
        <button class="btn" id="dc-back">&larr; Back</button>
        <div class="spacer"></div>
        ${dc.is_editable && !editing ? `<button class="btn" id="dc-edit">Edit</button>` : ''}
        <button class="btn btn-primary" id="dc-print">Print</button>
      </div>
      <div class="doc-sheet">
        <img class="doc-logo" src="/assets/logo-wordmark.png" alt="JK Racks" />
        <div class="doc-head">
          <div>
            <div style="font-size:20px; font-weight:800;">${esc(dc.dc_no)}</div>
            <div style="color:var(--ink-4); font-size:13px; margin-top:4px;">${dc.direction === 'in' ? 'Input DC' : 'Output DC'} &middot; ${esc(dc.location_name || '')}</div>
          </div>
          <div style="text-align:right;">
            <div class="lbl" style="font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); font-weight:600;">Date</div>
            <div style="font-weight:600; margin-top:2px;">${JKFmt.dateTime(dc.created_at)}</div>
          </div>
        </div>
        ${editing ? renderEditForm(isAdmin) : renderReadOnly(isAdmin)}
      </div>
      ${isAdmin && !editing ? renderHistorySection() : ''}
    `;
    document.getElementById('dc-back').onclick = () => { window.location.href = backHref(); };
    document.getElementById('dc-print').onclick = () => window.print();
    const editBtn = document.getElementById('dc-edit');
    if (editBtn) editBtn.onclick = () => { editing = true; render(); };
    if (editing) wireEditForm(isAdmin);
    if (isAdmin && !editing) wireHistorySection();
  }

  function renderReadOnly(isAdmin) {
    const rows = dc.lines.map((l, i) => `
      <tr>
        <td class="sr">${i + 1}</td>
        <td>${esc(l.item_name)}</td>
        <td class="num">${JKFmt.qty(l.qty)} ${esc(l.unit)}</td>
        ${isAdmin ? `<td class="num">${JKFmt.money(l.price)}</td><td class="num">${JKFmt.money(l.value)}</td>` : ''}
      </tr>
    `).join('');
    return `
      <div class="dc-meta-grid">
        ${dc.party ? metaCell('Party', dc.party) : ''}
        ${dc.vehicle_no ? metaCell('Vehicle', dc.vehicle_no) : ''}
        ${dc.address ? metaCell('Address', dc.address) : ''}
        ${dc.note ? metaCell('Note', dc.note) : ''}
      </div>
      <table>
        <thead><tr><th class="sr">Sr.</th><th>Description</th><th class="num">Qty</th>${isAdmin ? '<th class="num">Rate</th><th class="num">Amount</th>' : ''}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${isAdmin ? `<div style="text-align:right; font-weight:800; font-size:16px;">Total: ${JKFmt.money(dc.total_value)}</div>` : ''}
      <div class="doc-sig"><div class="box">Authorised signatory</div></div>
      <div class="dc-status-line">
        <span><b>Recorded by</b> ${esc(dc.created_by_name || 'Unknown')}</span>
        ${dc.edited_by_name ? `<span><b>Last edited by</b> ${esc(dc.edited_by_name)} on ${JKFmt.dateTime(dc.updated_at)} (${dc.edit_count} edit${dc.edit_count === 1 ? '' : 's'})</span>` : ''}
        ${dc.is_editable ? `<span>Editable until ${JKFmt.dateTime(new Date(new Date(dc.created_at).getTime() + dc.edit_window_hours * 3600 * 1000).toISOString())}${user.role === 'admin' ? ' (admin: no limit)' : ''}</span>` : ''}
      </div>
    `;
  }

  function metaCell(label, value) {
    return `<div><div class="lbl">${esc(label)}</div><div class="val">${esc(value)}</div></div>`;
  }

  function renderEditForm(isAdmin) {
    const isOut = dc.direction === 'out';
    return `
      <div class="field"><label>Party</label><input id="e-party" value="${escAttr(dc.party || '')}" ${isOut ? 'required' : ''} /></div>
      ${isOut ? `<div class="field"><label>Vehicle number</label><input id="e-vehicle" value="${escAttr(dc.vehicle_no || '')}" /></div>
      <div class="field"><label>Address</label><input id="e-address" value="${escAttr(dc.address || '')}" /></div>` : ''}
      <div class="field"><label>Note</label><input id="e-note" value="${escAttr(dc.note || '')}" /></div>
      <div class="field">
        <label>Lines — adjust quantity per item</label>
        <div class="dc-edit-lines">
          ${dc.lines.map((l) => `
            <div class="line-row-edit" data-item="${l.item_id}">
              <div class="nm">${esc(l.item_name)} <span style="color:var(--ink-4);">(${esc(l.unit)})</span></div>
              <input type="number" min="0.001" step="any" class="e-qty" value="${l.qty}" />
            </div>
          `).join('')}
        </div>
      </div>
      ${isAdmin ? `
      <label class="affect-stock-row">
        <input type="checkbox" id="e-affect-stock" checked />
        <span>
          <span class="t1" style="font-weight:600;">Apply this change to stock</span>
          <span class="t2">On: the new quantities are reconciled against \`stock\` right now (a real correction). Off: only this record changes — physical stock is left exactly as it is (use for fixing a typo, not a quantity mistake).</span>
        </span>
      </label>` : `<div class="field hint" style="color:var(--ink-4); font-size:12px;">This edit will update stock to match the corrected quantities.</div>`}
      <div class="field error hidden" id="e-error"></div>
      <div style="display:flex; gap:10px; margin-top:16px;">
        <button class="btn btn-primary" id="e-save">Save correction</button>
        <button class="btn" id="e-cancel">Cancel</button>
      </div>
    `;
  }

  function wireEditForm(isAdmin) {
    document.getElementById('e-cancel').onclick = () => { editing = false; render(); };
    document.getElementById('e-save').onclick = async (e) => {
      const btn = e.target;
      const errorEl = document.getElementById('e-error');
      errorEl.classList.add('hidden');
      const lines = [...document.querySelectorAll('.line-row-edit')].map((row) => ({
        item_id: row.dataset.item,
        qty: Number(row.querySelector('.e-qty').value),
      }));
      if (lines.some((l) => !(l.qty > 0))) {
        errorEl.textContent = 'Every line needs a quantity greater than zero.';
        errorEl.classList.remove('hidden');
        return;
      }
      const body = {
        party: document.getElementById('e-party')?.value ?? dc.party,
        vehicle_no: document.getElementById('e-vehicle')?.value ?? dc.vehicle_no,
        address: document.getElementById('e-address')?.value ?? dc.address,
        note: document.getElementById('e-note')?.value ?? dc.note,
        lines,
      };
      if (isAdmin) body.affect_stock = document.getElementById('e-affect-stock').checked;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await window.JKApi.editDc(dc.id, body);
        JKToast.good('DC updated.');
        await load();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Save correction';
      }
    };
  }

  function renderHistorySection() {
    return `
      <div class="card card-pad" style="margin-top:18px;">
        <div style="font-weight:700; margin-bottom:2px;">Edit history</div>
        <div id="dc-history"><div class="loading-state">Loading…</div></div>
      </div>
    `;
  }

  async function wireHistorySection() {
    const el = document.getElementById('dc-history');
    try {
      const { edits } = await window.JKApi.dcHistory(dc.id);
      if (!edits.length) { el.innerHTML = `<div class="empty-state" style="padding:20px 0;">No edits yet.</div>`; return; }
      el.innerHTML = edits.map((e) => `
        <div class="dc-history-row">
          <span class="who">${esc(e.edited_by_name || 'Unknown')}</span> &middot;
          ${JKFmt.dateTime(e.edited_at)} &middot;
          <span class="flag ${e.affected_stock ? 'stock' : 'no-stock'}">${e.affected_stock ? 'affected stock' : 'record only'}</span>
          <div style="color:var(--ink-4); margin-top:3px;">${diffSummary(e.before_snapshot, e.after_snapshot)}</div>
        </div>
      `).join('');
    } catch (err) {
      el.innerHTML = `<div class="empty-state" style="padding:20px 0;">Could not load history — ${esc(err.message)}</div>`;
    }
  }

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

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

  boot();
})();
