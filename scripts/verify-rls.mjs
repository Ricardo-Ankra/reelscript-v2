// =============================================================================
// Phase 0 RLS verification
// =============================================================================
// Two independent checks against a live database (local stack or hosted):
//
//   A. Structural coverage (dynamic, no hardcoded count): every base table in
//      the public schema must have row-level security enabled, and have at
//      least one policy. Fails listing any table that does not. This can't
//      silently pass while missing a table.
//
//   B. Behavioural isolation (the milestone): two real accounts, exercised
//      through the RLS-enforced anon path. Account A inserts a channel; account
//      B cannot read it, and B cannot write a row under A's account_id.
//
// Run: npm run verify:rls   (loads .env.local via node --env-file)
// Needs: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
//        SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL
// =============================================================================

import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = process.env.SUPABASE_DB_URL;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required env var: ${name} (set it in .env.local)`);
    process.exit(2);
  }
}
requireEnv('NEXT_PUBLIC_SUPABASE_URL', URL);
requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON);
requireEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE);
requireEnv('SUPABASE_DB_URL', DB_URL);

const failures = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  failures.push(m);
  console.log(`  ✗ ${m}`);
};

// A fresh anon client per user; signing in populates its in-memory session,
// which it then uses for every subsequent request — the real RLS path.
function anonClient() {
  return createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function structuralCheck() {
  console.log('\nA. Structural RLS coverage (public schema)');
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const { rows: noRls } = await client.query(`
      select tablename
      from pg_tables
      where schemaname = 'public' and rowsecurity = false
      order by tablename
    `);
    const { rows: counts } = await client.query(`
      select count(*)::int as n
      from pg_tables where schemaname = 'public'
    `);
    const { rows: noPolicy } = await client.query(`
      select t.tablename
      from pg_tables t
      where t.schemaname = 'public'
        and not exists (
          select 1 from pg_policies p
          where p.schemaname = 'public' and p.tablename = t.tablename
        )
      order by t.tablename
    `);

    console.log(`  (${counts[0].n} base tables in public)`);
    if (noRls.length === 0) ok('every public table has RLS enabled');
    else fail(`tables WITHOUT RLS: ${noRls.map((r) => r.tablename).join(', ')}`);

    if (noPolicy.length === 0) ok('every public table has at least one policy');
    else
      fail(
        `tables WITHOUT any policy: ${noPolicy.map((r) => r.tablename).join(', ')}`,
      );
  } finally {
    await client.end();
  }
}

async function behaviouralCheck() {
  console.log('\nB. Cross-account isolation (RLS-enforced anon path)');
  const admin = createClient(URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const password = `Pw-${randomUUID()}`;
  const emailA = `rls-a-${randomUUID()}@example.com`;
  const emailB = `rls-b-${randomUUID()}@example.com`;
  const created = [];

  try {
    const a = await admin.auth.admin.createUser({
      email: emailA,
      password,
      email_confirm: true,
    });
    const b = await admin.auth.admin.createUser({
      email: emailB,
      password,
      email_confirm: true,
    });
    if (a.error) throw a.error;
    if (b.error) throw b.error;
    created.push(a.data.user.id, b.data.user.id);

    const clientA = anonClient();
    const clientB = anonClient();
    const signinA = await clientA.auth.signInWithPassword({
      email: emailA,
      password,
    });
    const signinB = await clientB.auth.signInWithPassword({
      email: emailB,
      password,
    });
    if (signinA.error) throw signinA.error;
    if (signinB.error) throw signinB.error;
    ok('both accounts can sign in');

    // Each user sees exactly their own account row (provisioned by the trigger).
    const acctA = await clientA.from('accounts').select('id').single();
    const acctB = await clientB.from('accounts').select('id').single();
    if (acctA.error || !acctA.data)
      fail(`A cannot read its own account row: ${acctA.error?.message}`);
    else ok('A sees its own account row (handle_new_user trigger worked)');
    if (acctB.error || !acctB.data)
      fail(`B cannot read its own account row: ${acctB.error?.message}`);
    else ok('B sees its own account row');

    const accountA = acctA.data?.id;
    const accountB = acctB.data?.id;
    if (accountA && accountB && accountA !== accountB)
      ok('the two accounts are distinct');

    // A inserts a channel under its own account.
    const ins = await clientA
      .from('channels')
      .insert({ account_id: accountA, name: 'A private channel' })
      .select('id')
      .single();
    if (ins.error || !ins.data)
      fail(`A could not create a channel under its own account: ${ins.error?.message}`);
    else ok('A created a channel under its own account');

    // THE CHECK: B cannot read A's channel.
    const bReads = await clientB.from('channels').select('id, name');
    if (bReads.error) fail(`B channel read errored: ${bReads.error.message}`);
    else if ((bReads.data ?? []).length === 0)
      ok("B cannot read A's rows (SELECT isolation holds)");
    else fail(`B read ${bReads.data.length} channel row(s) it should not see`);

    // THE OTHER CHECK: B cannot write a row tagged with A's account_id.
    const bWrites = await clientB
      .from('channels')
      .insert({ account_id: accountA, name: 'B forging into A' })
      .select('id');
    if (bWrites.error)
      ok(`B blocked from writing under A's account_id (${bWrites.error.code ?? 'rejected'})`);
    else if ((bWrites.data ?? []).length === 0)
      ok("B's forged write returned no row (with-check blocked it)");
    else fail("B successfully wrote a row under A's account_id");
  } finally {
    for (const id of created) {
      await admin.auth.admin.deleteUser(id).catch(() => {});
    }
    if (created.length) console.log('  (cleaned up test users)');
  }
}

async function main() {
  console.log('Phase 0 RLS verification');
  console.log(`Target: ${URL}`);
  await structuralCheck();
  await behaviouralCheck();

  console.log('');
  if (failures.length) {
    console.error(`FAILED (${failures.length} problem(s)):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('PASSED — RLS coverage complete and cross-account isolation holds.');
}

main().catch((e) => {
  console.error('verify-rls crashed:', e);
  process.exit(1);
});
