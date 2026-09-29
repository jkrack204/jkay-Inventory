-- Migration 006: username-based login
--
-- Logins now sign in with a username, not an email address. Supabase Auth
-- itself is still email-only under the hood, so nothing about the Auth
-- layer changes: every login still has a Supabase Auth user with an
-- email — it's just no longer a real one. The app already did this for
-- every login provisioned so far (fab@jkayracks.local, etc.) — this
-- migration just makes that the documented, enforced pattern instead of
-- an informal convention, and adds a place to store the person's real
-- email address alongside it (contact info only, never used to sign in).
--
--   inventory.profiles.username — what's typed into the login screen.
--     Unique, lowercase, backfilled from the existing synthetic Auth
--     email's local part (the bit before "@") for every login that
--     already exists, so nobody currently provisioned loses access.
--   inventory.profiles.email — the person's real email, optional,
--     collected and stored but never sent to Supabase Auth.
--
-- Safe to run any time: additive columns + one backfill + a uniqueness
-- constraint added only after the backfill guarantees every row has a
-- non-null value.

begin;

alter table inventory.profiles add column if not exists username text;
alter table inventory.profiles add column if not exists email text;

-- Backfill: every login provisioned so far already has a synthetic
-- "<something>@jkayracks.local" (or similar) Auth email — reuse that
-- local part as the username so existing logins keep working unchanged.
update inventory.profiles p
set username = lower(split_part(u.email, '@', 1))
from auth.users u
where p.id = u.id
  and p.username is null;

alter table inventory.profiles alter column username set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_username_unique'
  ) then
    alter table inventory.profiles add constraint profiles_username_unique unique (username);
  end if;
end $$;

commit;
