const { supabaseAdmin } = require('../lib/supabase');

/**
 * Verifies the Supabase-issued bearer token on every request, then loads
 * that user's profile (role + location_id) and attaches it to req.user.
 *
 * This is the server-side enforcement point: an operator's token is
 * scoped to their own location right here, not just hidden in the UI —
 * every route below trusts req.user.locationId instead of anything the
 * client sends.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .schema('inventory')
    .from('profiles')
    .select('id, full_name, role, location_id')
    .eq('id', userData.user.id)
    .single();

  if (profileError || !profile) {
    return res.status(403).json({ error: 'No inventory profile for this account' });
  }

  req.user = {
    id: profile.id,
    fullName: profile.full_name,
    role: profile.role, // 'operator' | 'admin'
    locationId: profile.location_id, // null for admin
  };

  next();
}

/** Blocks non-admins. Use after requireAuth. */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Resolves which location a request should operate on:
 *   - Admin may pass ?location=<id> (or body.location_id) to pick one.
 *   - Operators are always pinned to their own location; any location
 *     they pass is ignored — this is what makes cross-location access
 *     impossible even if the client is modified or the request is
 *     replayed with a tampered location id.
 */
function resolveLocationId(req) {
  if (req.user.role === 'admin') {
    return req.query.location || req.body?.location_id || null;
  }
  return req.user.locationId;
}

/**
 * Resolves the location an operator wants to *peek* at read-only — the
 * other location, never their own, and never a client-supplied id. Used
 * for the "see both" cross-location stock view: Fabrication can look at
 * Finished's tree/stock and vice versa, but only to read, never to write
 * a DC or see price. Requires `?peek=1` (any truthy value) plus the full
 * location list so we can find "the other one" server-side.
 *
 * Returns null unless the request is an operator explicitly asking to
 * peek — admin and non-peek requests never get a peeked location.
 */
function resolvePeekLocationId(req, locations) {
  if (req.user.role !== 'operator') return null;
  if (!req.query.peek) return null;
  const other = (locations || []).find((l) => l.id !== req.user.locationId);
  return other ? other.id : null;
}

module.exports = { requireAuth, requireAdmin, resolveLocationId, resolvePeekLocationId };
