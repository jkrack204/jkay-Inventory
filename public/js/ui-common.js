// Shared UI bits used by both the location desk (fab/finished) and admin:
// theme/density application (dark mode + row density), the logo mark, and
// the Settings modal. Kept separate so both entry points share one
// implementation instead of drifting.
(function () {
  const PREF_KEY = 'jkay.prefs.v1';

  function loadPrefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch (e) { p = {}; }
    return Object.assign({
      appearance: 'system', // 'light' | 'dark' | 'system'
      density: 'comfortable', // 'comfortable' | 'compact'
      hideZero: false,
      expandDefault: false,
    }, p);
  }
  function savePrefs(p) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) {}
  }

  function effectiveTheme(p) {
    if (p.appearance === 'light' || p.appearance === 'dark') return p.appearance;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }

  function applyPrefs(p) {
    const theme = effectiveTheme(p);
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-density', p.density);
    document.body.classList.toggle('comfortable', p.density === 'comfortable');
    document.body.classList.toggle('compact', p.density === 'compact');
  }

  let prefs = loadPrefs();
  applyPrefs(prefs);
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      if (prefs.appearance === 'system') applyPrefs(prefs);
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- Logo mark (real JK Racks lockup, supplied by the client) ----
  // Same wordmark file used on the login screen — one logo across the app
  // instead of the separate icon+wordmark variant that used to live here.
  function logoMarkHtml() {
    return `
      <span class="brand-mark">
        <img src="/assets/logo-wordmark.png" alt="JK Racks" />
      </span>
    `;
  }

  // ---- Settings modal ----
  // openSettingsModal({ lowStockCount }) — lowStockCount is optional, shown
  // in the info box ("Admin flags anything at or below N. M item(s) low
  // here right now.") when the caller has it; omitted for admin/no-location
  // contexts.
  function openSettingsModal(opts) {
    opts = opts || {};
    const existing = document.getElementById('settings-modal-scrim');
    if (existing) existing.remove();

    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    scrim.id = 'settings-modal-scrim';
    scrim.innerHTML = `
      <div class="modal" style="max-width:440px;">
        <div class="modal-head" style="flex-direction:column; align-items:flex-start; gap:2px;">
          <div class="title">Settings</div>
          <div class="settings-modal-sub">How this desk displays stock. Prices and alerts are set by admin.</div>
        </div>
        <div class="modal-body">
          <div class="settings-section">
            <div class="label">Appearance</div>
            <div class="seg-3" data-seg="appearance">
              <button data-val="light">Light</button>
              <button data-val="dark">Dark</button>
              <button data-val="system">System</button>
            </div>
          </div>
          <div class="settings-section" style="margin-top:18px;">
            <div class="label">Row density</div>
            <div class="seg-2" data-seg="density">
              <button data-val="comfortable">Comfortable</button>
              <button data-val="compact">Compact</button>
            </div>
          </div>
          <button type="button" class="toggle-row" data-toggle="hideZero">
            <span class="t-main">
              <span class="t-title">Hide items at zero</span>
              <span class="t-sub">Keeps empty rows out of the table.</span>
            </span>
            <span class="switch"><span class="knob"></span></span>
          </button>
          <button type="button" class="toggle-row" data-toggle="expandDefault">
            <span class="t-main">
              <span class="t-title">Open every category by default</span>
              <span class="t-sub">The tree starts fully expanded.</span>
            </span>
            <span class="switch"><span class="knob"></span></span>
          </button>
          ${opts.lowStockThreshold != null ? `
          <div class="settings-info">
            <div class="t1">Low-stock alert</div>
            <div class="t2">Admin flags anything at or below ${opts.lowStockThreshold}. ${opts.lowStockCount ?? 0} item${(opts.lowStockCount ?? 0) === 1 ? '' : 's'} low here right now.</div>
          </div>` : ''}
          <div class="settings-section" style="margin-top:18px; border-top:1px solid var(--rule-3); padding-top:16px;">
            <button type="button" class="btn" id="settings-change-pw" style="width:100%;">Change my password</button>
            <div id="settings-pw-form" class="hidden" style="margin-top:12px;">
              <div class="field"><label>Current password</label><input id="pw-current" type="password" autocomplete="current-password" /></div>
              <div class="field"><label>New password</label><input id="pw-new" type="password" autocomplete="new-password" placeholder="At least 8 characters" /></div>
              <div class="field"><label>Confirm new password</label><input id="pw-confirm" type="password" autocomplete="new-password" /></div>
              <div class="field error hidden" id="pw-error"></div>
              <button type="button" class="btn btn-primary" id="pw-save" style="width:100%; margin-top:4px;">Save new password</button>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" style="background:var(--invert-bg); color:var(--invert-ink); border:none;" id="settings-done">Done</button>
        </div>
      </div>
    `;
    document.body.appendChild(scrim);
    scrim.addEventListener('click', (e) => { if (e.target === scrim) scrim.remove(); });
    scrim.querySelector('#settings-done').onclick = () => scrim.remove();

    function refresh() {
      scrim.querySelectorAll('.seg-3 button').forEach((b) => b.classList.toggle('active', b.dataset.val === prefs.appearance));
      scrim.querySelectorAll('.seg-2 button').forEach((b) => b.classList.toggle('active', b.dataset.val === prefs.density));
      scrim.querySelectorAll('.toggle-row').forEach((row) => {
        const key = row.dataset.toggle;
        row.querySelector('.switch').classList.toggle('on', !!prefs[key]);
      });
    }
    refresh();

    scrim.querySelector('[data-seg="appearance"]').querySelectorAll('button').forEach((b) => {
      b.onclick = () => { prefs.appearance = b.dataset.val; savePrefs(prefs); applyPrefs(prefs); refresh(); };
    });
    scrim.querySelector('[data-seg="density"]').querySelectorAll('button').forEach((b) => {
      b.onclick = () => { prefs.density = b.dataset.val; savePrefs(prefs); applyPrefs(prefs); refresh(); if (opts.onChange) opts.onChange(prefs); };
    });
    scrim.querySelectorAll('.toggle-row').forEach((row) => {
      row.onclick = () => {
        const key = row.dataset.toggle;
        prefs[key] = !prefs[key];
        savePrefs(prefs);
        refresh();
        if (opts.onChange) opts.onChange(prefs);
      };
    });

    // Self-service password change — any signed-in login (operator or
    // admin), not just an admin resetting someone else's from Users.
    const pwToggleBtn = scrim.querySelector('#settings-change-pw');
    const pwForm = scrim.querySelector('#settings-pw-form');
    pwToggleBtn.onclick = () => { pwForm.classList.toggle('hidden'); };
    scrim.querySelector('#pw-save').onclick = async (e) => {
      const btn = e.target;
      const currentEl = scrim.querySelector('#pw-current');
      const newEl = scrim.querySelector('#pw-new');
      const confirmEl = scrim.querySelector('#pw-confirm');
      const errorEl = scrim.querySelector('#pw-error');
      errorEl.classList.add('hidden');
      const current = currentEl.value;
      const next = newEl.value;
      if (!current || !next) {
        errorEl.textContent = 'Enter your current and new password.'; errorEl.classList.remove('hidden'); return;
      }
      if (next.length < 8) {
        errorEl.textContent = 'New password must be at least 8 characters.'; errorEl.classList.remove('hidden'); return;
      }
      if (next !== confirmEl.value) {
        errorEl.textContent = "New passwords don't match."; errorEl.classList.remove('hidden'); return;
      }
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await window.JKApi.changeMyPassword(current, next);
        window.JKToast?.good('Password changed.');
        currentEl.value = ''; newEl.value = ''; confirmEl.value = '';
        pwForm.classList.add('hidden');
      } catch (err) {
        errorEl.textContent = err.message; errorEl.classList.remove('hidden');
      }
      btn.disabled = false;
      btn.textContent = 'Save new password';
    };
  }

  // ---- Opening a DC in a new tab, without losing the session ----
  // Auth is session-only (sessionStorage), which is NOT shared with a tab
  // opened via a plain `<a target="_blank">` click — Chrome does not clone
  // sessionStorage into it (this used to be blamed on rel="noopener", but
  // it happens even without that: a link click just isn't script-driven
  // the way window.open() is). window.open() DOES hand back a same-origin
  // window reference before it navigates, so we can copy every
  // sessionStorage key into it directly and only then send it to the real
  // URL — the new tab has a logged-in session before its first request.
  // If the popup is blocked, fall back to navigating in place.
  function openInNewTab(url) {
    const win = window.open('', '_blank');
    if (!win) { window.location.href = url; return; }
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        win.sessionStorage.setItem(key, sessionStorage.getItem(key));
      }
    } catch (e) { /* cross-origin or storage disabled — new tab just logs in fresh */ }
    win.location.href = url;
  }

  // Delegated at the document level so every current and future
  // target="_blank" link to dc.html is covered from one place, instead of
  // repeating this at every call site that renders a DC row.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[target="_blank"]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (!href.startsWith('/dc.html')) return;
    e.preventDefault();
    openInNewTab(link.href);
  });

  window.JKUi = {
    getPrefs: () => prefs,
    applyPrefs,
    logoMarkHtml,
    openSettingsModal,
    escapeHtml,
    openInNewTab,
  };
})();
