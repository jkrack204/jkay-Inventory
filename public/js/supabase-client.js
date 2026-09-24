// Loads runtime config (Supabase URL + anon key) that index.html/login.html
// inject via a small inline <script> tag setting window.__JKAY_CONFIG__, and
// exposes a single shared Supabase client for browser-side Auth.
//
// The service-role key never appears here — only the public anon key, which
// is safe to ship to the browser. Every other request (all real data) goes
// through the Express API, which is the only thing holding the service key.

(function () {
  const cfg = window.__JKAY_CONFIG__ || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    console.error('Missing Supabase config — set window.__JKAY_CONFIG__ before loading this script.');
  }
  window.supabaseClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  window.JKAuth = {
    async getSession() {
      const { data } = await window.supabaseClient.auth.getSession();
      return data.session;
    },
    async signIn(email, password) {
      return window.supabaseClient.auth.signInWithPassword({ email, password });
    },
    async signOut() {
      await window.supabaseClient.auth.signOut();
      window.location.href = '/login.html';
    },
    /** Redirects to /login.html if there's no session; returns the session otherwise. */
    async requireSession() {
      const session = await this.getSession();
      if (!session) {
        window.location.href = '/login.html';
        return null;
      }
      return session;
    },
  };
})();
