const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Every route here is admin-only — creating logins is an admin action,
// same as editing the item tree.
router.use(requireAdmin);

// GET /api/users — every login (profile), with email pulled from the
// matching Supabase Auth user and the location name resolved for
// operators. Used by Admin's "Users" screen.
router.get('/', async (req, res, next) => {
  try {
    const { data: profiles, error: profileError } = await supabaseAdmin
      .schema('inventory')
      .from('profiles')
      .select('id, full_name, role, location_id')
      .order('full_name');
    if (profileError) return res.status(400).json({ error: profileError.message });

    const { data: locations } = await supabaseAdmin
      .schema('inventory')
      .from('locations')
      .select('id, name');
    const locationNameById = new Map((locations || []).map((l) => [l.id, l.name]));

    // supabase-js has no "get users by id list" call, so the auth user
    // list is paged through once and matched by id — fine at this scale
    // (a handful of logins for a shop-floor tool).
    const emailById = new Map();
    let page = 1;
    for (;;) {
      const { data: page_data, error: listError } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
      if (listError) return res.status(400).json({ error: listError.message });
      for (const u of page_data.users) emailById.set(u.id, u.email);
      if (page_data.users.length < 200) break;
      page += 1;
    }

    const users = profiles.map((p) => ({
      id: p.id,
      full_name: p.full_name,
      role: p.role,
      location_id: p.location_id,
      location_name: p.location_id ? locationNameById.get(p.location_id) || null : null,
      email: emailById.get(p.id) || null,
    }));

    res.json({ users });
  } catch (err) {
    next(err);
  }
});

// POST /api/users — create a new login: a Supabase Auth user plus its
// matching inventory.profiles row. Mirrors scripts/provision-user.js,
// just reachable from the Admin UI instead of the command line.
// body: { email, password, full_name, role: 'operator'|'admin', location_id? }
router.post('/', async (req, res, next) => {
  try {
    const { email, password, full_name, role } = req.body;
    let { location_id } = req.body;

    if (!email || !password || !full_name || !role) {
      return res.status(400).json({ error: 'email, password, full_name and role are required' });
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

    const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createError) return res.status(400).json({ error: createError.message });

    const { data: profile, error: profileError } = await supabaseAdmin
      .schema('inventory')
      .from('profiles')
      .insert({ id: created.user.id, full_name, role, location_id })
      .select()
      .single();

    if (profileError) {
      // Auth user exists but the profile insert failed — undo the auth
      // user so a retry with the same email doesn't collide.
      await supabaseAdmin.auth.admin.deleteUser(created.user.id);
      return res.status(400).json({ error: profileError.message });
    }

    res.status(201).json({
      user: {
        id: profile.id,
        full_name: profile.full_name,
        role: profile.role,
        location_id: profile.location_id,
        email,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/users/:id — reset a login's password, or rename it.
// body: any of { password, full_name }
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { password, full_name } = req.body;

    if (password !== undefined) {
      if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
      const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { password });
      if (error) return res.status(400).json({ error: error.message });
    }
    if (full_name !== undefined) {
      const { error } = await supabaseAdmin
        .schema('inventory')
        .from('profiles')
        .update({ full_name })
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
