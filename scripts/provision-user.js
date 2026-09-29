#!/usr/bin/env node
/**
 * Creates one of the tool's logins: a Supabase Auth user (keyed by a
 * synthetic "<username>@jkayracks.local" address) plus its matching
 * inventory.profiles row. Logins sign in with a username, not an email —
 * the real email (optional) is just stored on the profile for records.
 *
 * Usage:
 *   node scripts/provision-user.js --username fab --password "..." \
 *     --name "Fabrication Desk" --role operator --location Fabrication
 *
 *   node scripts/provision-user.js --username admin --password "..." \
 *     --name "Admin" --role admin --email admin@realdomain.com
 *
 * Requires .env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) to be set.
 * Run this once per login when setting up, or again later to add one.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const AUTH_EMAIL_DOMAIN = 'jkayracks.local';
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

async function main() {
  const { username: rawUsername, password, name, role, location, email } = parseArgs();
  const username = String(rawUsername || '').trim().toLowerCase();

  if (!username || !password || !name || !role) {
    console.error(
      'Usage: node scripts/provision-user.js --username <username> --password <password> --name "<Full Name>" --role operator|admin [--location Fabrication|Finished] [--email <real email, optional>]'
    );
    process.exit(1);
  }
  if (!USERNAME_RE.test(username)) {
    console.error('--username must be 3-32 characters: lowercase letters, numbers, dot, underscore or hyphen');
    process.exit(1);
  }
  if (!['operator', 'admin'].includes(role)) {
    console.error('--role must be "operator" or "admin"');
    process.exit(1);
  }
  if (role === 'operator' && !location) {
    console.error('--location is required for an operator account');
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let locationId = null;
  if (role === 'operator') {
    const { data: loc, error: locError } = await supabase
      .schema('inventory')
      .from('locations')
      .select('id')
      .eq('name', location)
      .single();
    if (locError || !loc) {
      console.error(`Location "${location}" not found. Run db/schema.sql first (it seeds Fabrication and Finished).`);
      process.exit(1);
    }
    locationId = loc.id;
  }

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email: `${username}@${AUTH_EMAIL_DOMAIN}`,
    password,
    email_confirm: true,
  });
  if (createError) {
    console.error('Failed to create auth user:', createError.message);
    process.exit(1);
  }

  const { error: profileError } = await supabase
    .schema('inventory')
    .from('profiles')
    .insert({ id: created.user.id, username, full_name: name, role, location_id: locationId, email: email || null });

  if (profileError) {
    console.error('Auth user created, but failed to create profile:', profileError.message);
    console.error(`You can retry by inserting a profile row manually for user id ${created.user.id}.`);
    process.exit(1);
  }

  console.log(`Created ${role} login: username "${username}" (${name})${location ? ` — ${location}` : ''}`);
}

main();
