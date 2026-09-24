# JKAY Racks — Inventory & Fabrication Tool

Internal stock-tracking tool for JKAY Racks Metal Sheet Works. Tracks
material and consumable stock at two locations — **Fabrication** and
**Finished** — plus an **Admin** view across both, all moved through a
single Input DC / Output DC mechanism. Full design spec: see the project
docs (`JKAY_Inventory_Build_Plan.md`, `JKAY_Inventory_Handover.md`).

One Express app serves both the JSON API and the static frontend. Data and
login live in Supabase (Postgres + Auth). Deployed as a single Railway
service.

## 1. Set up Supabase

1. Create a Supabase project (or use an existing one — this tool lives
   entirely in its own `inventory` Postgres schema, so it's safe to share
   a project with other apps).
2. Open the SQL Editor and run `db/schema.sql` once. It creates the
   `inventory` schema, all tables/triggers/functions, and seeds the two
   locations (Fabrication, Finished).
3. From **Project Settings → API**, copy:
   - Project URL → `SUPABASE_URL`
   - `anon` public key → `SUPABASE_ANON_KEY` (not used server-side yet, but
     kept for a future browser-side Supabase Auth client)
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` — **server-only,
     never commit this or ship it to the browser.**

## 2. Configure environment

```bash
cp .env.example .env
# fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
```

## 3. Install and run locally

```bash
npm install
npm run dev      # auto-restarts on file changes
# or: npm start
```

The app listens on `http://localhost:3000` (or `$PORT`). Every `/api/*`
route requires a valid Supabase bearer token, so `curl localhost:3000/api/locations`
with no `Authorization` header should return `401` — that's expected until
a real login exists.

## 4. Create the three logins

Each login is a Supabase Auth user plus a row in `inventory.profiles`
(role + location). Create them with the provisioning script:

```bash
node scripts/provision-user.js --email fab@jkayracks.com --password "choose-a-strong-password" \
  --name "Fabrication Desk" --role operator --location Fabrication

node scripts/provision-user.js --email finished@jkayracks.com --password "choose-a-strong-password" \
  --name "Finished Desk" --role operator --location Finished

node scripts/provision-user.js --email admin@jkayracks.com --password "choose-a-strong-password" \
  --name "Admin" --role admin
```

## 5. Deploy to Railway

No GitHub repo required — deploy this folder directly with the Railway CLI:

```bash
npm install -g @railway/cli   # once
railway login
railway init                  # first time only, inside this folder
railway up
```

Then, in the Railway dashboard, set the same environment variables from
your `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) on the service —
Railway sets `PORT` itself. Railway gives you a public URL once deployed;
that URL is the whole app (API + frontend), no separate frontend host
needed.

## Project layout

```
db/schema.sql          Postgres schema — run once in Supabase's SQL editor
src/index.js            Express entry point (API + static frontend)
src/middleware/auth.js  Supabase token verification + location scoping
src/routes/             /api/items, /api/dc, /api/locations, reports
scripts/provision-user.js  Create a login (operator or admin)
public/                 Frontend (Fabrication/Finished desk, Admin)
```

## How the data model works (short version)

- **Locations, not roles.** Fabrication and Finished are two rows in
  `locations` — identical mechanics, different data. An operator login is
  just an account pinned to one location's id.
- **One item tree, Admin-owned.** Categories can nest to any depth; only
  the bottom-most items (leaves) hold real stock and price. A parent's
  quantity/value is always computed by summing its leaves — never stored.
- **Universal price.** One price per item, set by Admin, used for every
  valuation. No per-transaction pricing.
- **Input DC / Output DC is the entire mechanism.** Recording stock
  arriving is always an Input DC; stock leaving (to the other location or
  to an outside customer) is always an Output DC. A "transfer" is just an
  Output DC from one location addressed to the other, logged as an Input
  DC when the other location receives it — two independent rows, mirroring
  a real paper delivery challan.
- **Price is Admin-only, enforced server-side.** Operator tokens never
  receive a price or value field from the API, regardless of what the UI
  shows.

See `db/schema.sql` for the exact tables/triggers and
`JKAY_Inventory_Build_Plan.md` (project docs) for the full spec this was
built from.
