const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !serviceRoleKey) {
  // Fail loudly at boot rather than surfacing confusing errors on first request.
  // eslint-disable-next-line no-console
  console.error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env and fill it in.'
  );
  process.exit(1);
}

// The one and only place the service-role key is used. This client can
// bypass RLS entirely, so it must never be sent to, or constructed in,
// the browser — every route enforces scoping itself (see middleware/auth.js).
const supabaseAdmin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Checks a plain-text password against Supabase Auth for the given email,
// using the same anon key the browser already gets from /config.js (no
// extra secret needed). Used only to confirm "current password" before a
// self-service password change — a fresh, stateless client per call so no
// session is ever persisted on the server.
async function verifyPassword(email, password) {
  if (!anonKey) throw new Error('SUPABASE_ANON_KEY not configured');
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await anon.auth.signInWithPassword({ email, password });
  return !error;
}

module.exports = { supabaseAdmin, verifyPassword };
