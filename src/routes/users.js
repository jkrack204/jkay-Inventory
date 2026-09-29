const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Internal domain used for every login's Supabase Auth identity. Auth
// itself is still email-based under the hood, but nobody signs in with
// this — it's derived from the username and never shown anywhere. The
// person's real email (optional) is stored separately on the profile row.
const AUTH_EMAIL_DOMAIN = 'jkayracks.local';

// 3-32 chars, lowercase letters/digits/dot/underscore/hyphen — safe to
// use as an email local-part and easy to type on a shop-floor device.
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;

function normalizeUsername(raw) {
  return String(raw || '').trim().toLowerCase();
}

function authEmailFor(username) {
  return `${username}@${AUTH_EMAIL_DOMAIN}`;
}

// Every route here is admin-only — creating logins is an admin action,
// same as editing the item tree.
router.use(requireAdmin);

// GET /api/users — every login (profile). Username and (optional) real
// email now live on the profile row itself, so this no longer needs to
// page through Supabase Auth's user list just to resolve an email.
router.get('/', async (req, res, next) => {
  try {
    const { data: profiles, error: profileError } = await supabaseAdmin
      .schema('inventory')
      .from('profiles')
      .select('id, username, full_name, role, location_id, email')
      .order('full_name');
    if (profileError) return res.status(400).json({ error: profileError.message });

    const { data: locations } = await supabaseAdmin
      .schema('inventory')
      .from('locations')
      .select('id, name');
    const locationNameById = new Map((locations || []).map((l) => [l.id, l.name]));

    const users = profiles.map((p) => ({
      id: p.id,
      username: p.username,
      full_name: p.full_name,
      role: p.role,
      location_id: p.location_id,
      location_name: p.location_id ? locationNameById.get(p.location_id) || null : null,
      email: p.email || null,
    }));

    res.json({ users });
  } catch (err) {
    next(err);
  }
});

// POST /api/users — create a new login: a Supabase Auth user (keyed by a
// synthetic internal address derived from the username) plus its matching
// inventory.profiles row (username + optional real email + role/location).
// body: { username, password, full_name, role: 'operator'|'admin', location_id?, email? }
router.post('/', async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body.username);
    const { password, full_name, role, email } = req.body;
    let { location_id } = req.body;

    if (!username || !password || !full_name || !role) {
      return res.status(400).json({ error: 'username, password, full_name and role are required' });
    }
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({
        error: 'username must be 3-32 characters: lowercase letters, numbers, dot, underscore or hyphen',
      });
    }
    if (!['operator', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'role must be operator or admin' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    if (role === 'operator') {
      if (!location_id) return res.status(400).json({ error: 'location_id is required for an operator account' });
      const { data: loc, error: locError } = await supabaseAdmin
        .schema('inventory')
        .from('locations')
        .select('id')
        .eq('id', location_id)
        .single();
      if (locError || !loc) return res.status(400).json({ error: 'location not found' });
    } else {
      location_id = null;
    }

    const { data: existing } = await supabaseAdmin
      .schema('inventory')
      .from('profiles')
      .select('id')
      .eq('username', username)
      .maybeSingle();
    if (existing) return res.status(400).json({ error: 'That username is already taken.' });

    const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: authEmailFor(username),
      password,
      email_confirm: true,
    });
    if (createError) return res.status(400).json({ error: createError.message });

    const { data: profile, error: profileError } = await supabaseAdmin
      .schema('inventory')
      .from('profiles')
      .insert({ id: created.user.id, username, full_name, role, location_id, email: email || null })
      .select()
      .single();

    if (profileError) {
      // Auth user exists but the profile insert failed — undo the auth
      // user so a retry with the same username doesn't collide.
      await supabaseAdmin.auth.admin.deleteUser(created.user.id);
      return res.status(400).json({ error: profileError.message });
    }

    res.status(201).json({
      user: {
        id: profile.id,
        username: profile.username,
        full_name: profile.full_name,
        role: profile.role,
        location_id: profile.location_id,
        email: profile.email,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/users/:id — reset a login's password, rename it, or update
// its stored contact email. Username is deliberately not editable here —
// renaming it would also mean renaming the underlying Auth identity
// (every session token stays valid, but it's more moving parts than this
// screen needs); remove and recreate the login if a username must change.
// body: any of { password, full_name, email }
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { password, full_name, email } = req.body;

    if (password !== undefined) {
      if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
      const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { password });
      if (error) return res.status(400).json({ error: error.message });
    }
    if (full_name !== undefined || email !== undefined) {
      const patch = {};
      if (full_name !== undefined) patch.full_name = full_name;
      if (email !== undefined) patch.email = email || null;
      const { error } = await supabaseAdmin
        .schema('inventory')
        .from('profiles')
        .update(patch)
        .eq('id', id);
      if (error) return res.status(400).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/users/:id — remove a login entirely (auth user + profile).
// Blocks removing your own account so an admin can't lock themself out.
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (id === req.user.id) {
      return res.status(400).json({ error: "You can't remove your own login." });
    }
    // Delete the Auth user first and check its error: if this fails, stop
    // here with the profile still intact rather than deleting the profile
    // first and risking an orphaned Auth user that can still authenticate
    // but 403s on every request with no profile left to identify it by.
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(id);
    if (authError) return res.status(400).json({ error: authError.message });
    const { error: profileError } = await supabaseAdmin.schema('inventory').from('profiles').delete().eq('id', id);
    if (profileError) {
      // The login itself is already gone (can't sign in), just the
      // bookkeeping row didn't clear — surface it so it isn't silently lost.
      return res.status(500).json({ error: `Login removed, but its profile row could not be cleaned up: ${profileError.message}` });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
