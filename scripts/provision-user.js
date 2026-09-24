#!/usr/bin/env node
/**
 * Creates one of the tool's logins: a Supabase Auth user plus its
 * matching inventory.profiles row.
 *
 * Usage:
 *   node scripts/provision-user.js --email fab@jkayracks.com --password "..." \
 *     --name "Fabrication Desk" --role operator --location Fabrication
 *
 *   node scripts/provision-user.js --email admin@jkayracks.com --password "..." \
 *     --name "Admin" --role admin
 *
 * Requires .env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) to be set.
 * Run this once per login when setting up (3 times total: Fabrication,
 * Finished, Admin), or again later to add/replace a user.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

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
  const { email, password, name, role, location } = parseArgs();

  if (!email || !password || !name || !role) {
    console.error(
      'Usage: node scripts/provision-user.js --email <email> --password <password> --name "<Full Name>" --role operator|admin [--location Fabrication|Finished]'
    );
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
    email,
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
    .insert({ id: created.user.id, full_name: name, role, location_id: locationId });

  if (profileError) {
    console.error('Auth user created, but failed to create profile:', profileError.message);
    console.error(`You can retry by inserting a profile row manually for user id ${created.user.id}.`);
    process.exit(1);
  }

  console.log(`Created ${role} login: ${email} (${name})${location ? ` — ${location}` : ''}`);
}

main();
