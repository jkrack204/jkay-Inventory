require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');

const { requireAuth } = require('./middleware/auth');
const { supabaseAdmin, verifyPassword } = require('./lib/supabase');
const { router: itemsRouter } = require('./routes/items');
const dcRouter = require('./routes/dc');
const reportsRouter = require('./routes/reports');
const locationsRouter = require('./routes/locations');
const usersRouter = require('./routes/users');

const app = express();
app.use(cors());
// gzip/brotli every JSON response and static asset — the single biggest
// "feels fast" win for a text-heavy API like this, at zero infra cost.
app.use(compression());
app.use(express.json());

// Unauthenticated — Railway's health check hits this to decide whether the
// deploy is alive. Deliberately outside requireAuth below: a health check
// that depends on a bearer token isn't a health check.
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Every /api/* route requires a valid Supabase bearer token and a
// matching inventory.profiles row; requireAuth attaches req.user.
app.use('/api', requireAuth);

app.use('/api/locations', locationsRouter);
app.use('/api/items', itemsRouter);
app.use('/api/dc', dcRouter);
app.use('/api', reportsRouter); // /api/out-of-stock, /api/low-stock, /api/valuation, /api/inventory-books
app.use('/api/users', usersRouter);

app.get('/api/me', (req, res) => res.json({ user: req.user }));

// PATCH /api/me/password — self-service password change for ANY signed-in
// login (operator or admin), not just an admin resetting someone else's.
// Requires the current password (verified against Supabase Auth itself,
// not just "you have a valid token") before the new one is set, same as
// any normal account-settings password change.
// body: { current_password, new_password }
app.patch('/api/me/password', async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'new password must be at least 8 characters' });
    }

    const { data: authUser, error: getError } = await supabaseAdmin.auth.admin.getUserById(req.user.id);
    if (getError || !authUser?.user?.email) {
      return res.status(400).json({ error: 'Could not verify your account' });
    }

    const currentOk = await verifyPassword(authUser.user.email, current_password);
    if (!currentOk) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, { password: new_password });
    if (updateError) return res.status(400).json({ error: updateError.message });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Serves the browser-side Supabase config (URL + anon key — both safe to
// expose) as a tiny script, generated from env vars rather than baked into
// a static file, so the same build works against any Supabase project.
app.get('/config.js', (req, res) => {
  res.type('application/javascript').send(
    `window.__JKAY_CONFIG__ = ${JSON.stringify({
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    })};`
  );
});

// Single Railway service: Express serves the static frontend too, so
// there's one deploy, one URL, one process — see JKAY_Inventory_Build_Plan.md §2.
//
// Caching: JS/CSS/HTML are always revalidated ('no-cache' — the browser
// still caches the file, but must check with the server on every load;
// unchanged files come back as a fast, bodyless 304, changed ones re-download).
// This is what makes a new deploy show up on next page load instead of
// silently running stale code for up to a day. Images/fonts/icons rarely
// change and aren't code, so they keep a long cache for speed.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`JKAY Racks Inventory listening on port ${port}`);
});
