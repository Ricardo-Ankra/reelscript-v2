// Apply a single SQL migration file to the database behind SUPABASE_DB_URL and
// record it in Supabase's migration ledger so the CLI stays consistent.
//
// We apply directly over the pooled connection (same path as verify:rls) rather
// than `supabase db push` because the CLI link state isn't kept locally; the
// file under supabase/migrations remains the source of truth.
//
// Run: npm run db:apply -- supabase/migrations/<file>.sql
//      (loads .env.local via node --env-file)
// Needs: SUPABASE_DB_URL
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error('Missing SUPABASE_DB_URL (set it in .env.local).');
  process.exit(2);
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run db:apply -- <path-to-migration.sql>');
  process.exit(2);
}

const sql = fs.readFileSync(file, 'utf8');
const base = path.basename(file, '.sql'); // e.g. 20260608120000_phase2_script
const version = base.split('_')[0];
const name = base.slice(version.length + 1);

async function main() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(sql);
    // Record in the ledger if it exists (created by `supabase db push`).
    try {
      await client.query(
        `insert into supabase_migrations.schema_migrations (version, name)
         values ($1, $2) on conflict (version) do nothing`,
        [version, name],
      );
      console.log(`Recorded migration ${version} in the ledger.`);
    } catch (e) {
      console.warn(`(Ledger not updated: ${e.message})`);
    }
    await client.query('commit');
    console.log(`Applied ${file}.`);
  } catch (e) {
    await client.query('rollback');
    console.error(`Migration failed, rolled back: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
