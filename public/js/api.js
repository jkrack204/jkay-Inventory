// Thin fetch wrapper for the Express API: attaches the current Supabase
// bearer token to every call, throws with the server's error message on a
// non-2xx response, and centralizes query-string building.

window.JKApi = (function () {
  async function authHeader() {
    const session = await window.JKAuth.getSession();
    if (!session) throw new Error('Not signed in');
    return { Authorization: `Bearer ${session.access_token}` };
  }

  function qs(params) {
    const usp = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') usp.set(k, v);
    });
    const s = usp.toString();
    return s ? `?${s}` : '';
  }

  async function request(method, path, { params, body } = {}) {
    const headers = await authHeader();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path + qs(params), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch (e) {
      /* no body */
    }
    if (!res.ok) {
      const message = payload?.error || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  // A CSV download still needs the bearer token, so it can't just be an
  // <a href>. Fetch it with auth like everything else, then hand the
  // browser the resulting blob as a normal file save.
  async function downloadCsv(path, params) {
    const headers = await authHeader();
    const res = await fetch(path + qs({ ...(params || {}), format: 'csv' }), { headers });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try { message = (await res.json())?.error || message; } catch (e) { /* no body */ }
      throw new Error(message);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
    const a = document.createElement('a');
    a.href = url;
    a.download = match ? match[1] : 'dcs-export.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return {
    get: (path, params) => request('GET', path, { params }),
    post: (path, body, params) => request('POST', path, { body, params }),
    patch: (path, body, params) => request('PATCH', path, { body, params }),
    put: (path, body, params) => request('PUT', path, { body, params }),

    me: () => request('GET', '/api/me'),
    changeMyPassword: (current_password, new_password) => request('PATCH', '/api/me/password', { body: { current_password, new_password } }),
    locations: () => request('GET', '/api/locations'),
    items: (params) => request('GET', '/api/items', { params }),
    createItem: (body) => request('POST', '/api/items', { body }),
    updateItem: (id, body) => request('PATCH', `/api/items/${id}`, { body }),
    recordDc: (body, params) => request('POST', '/api/dc', { body, params }),
    dcs: (params) => request('GET', '/api/dc', { params }),
    dc: (id) => request('GET', `/api/dc/${id}`),
    editDc: (id, body) => request('PATCH', `/api/dc/${id}`, { body }),
    dcHistory: (id) => request('GET', `/api/dc/${id}/history`),
    dcEdits: (params) => request('GET', '/api/dc/edits', { params }),
    exportDcs: (params) => downloadCsv('/api/dc', params),
    outOfStock: (params) => request('GET', '/api/out-of-stock', { params }),
    lowStock: (params) => request('GET', '/api/low-stock', { params }),
    setThreshold: (itemId, threshold, params) => request('PUT', `/api/low-stock/${itemId}`, { body: { threshold }, params }),
    valuation: (params) => request('GET', '/api/valuation', { params }),
    inventoryBooks: (params) => request('GET', '/api/inventory-books', { params }),
    users: () => request('GET', '/api/users'),
    createUser: (body) => request('POST', '/api/users', { body }),
    updateUser: (id, body) => request('PATCH', `/api/users/${id}`, { body }),
    deleteUser: (id) => request('DELETE', `/api/users/${id}`),
  };
})();

window.JKToast = (function () {
  let wrap = null;
  function ensure() {
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      document.body.appendChild(wrap);
    }
    return wrap;
  }
  function show(message, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = message;
    ensure().appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
  return {
    info: (m) => show(m, ''),
    good: (m) => show(m, 'good'),
    error: (m) => show(m, 'bad'),
  };
})();

window.JKFmt = {
  money(n) {
    const v = Number(n || 0);
    return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  },
  qty(n) {
    const v = Number(n || 0);
    return v % 1 === 0 ? v.toLocaleString('en-IN') : v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  },
  dateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' · ' +
      d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  },
  date(iso) {
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  },
};
