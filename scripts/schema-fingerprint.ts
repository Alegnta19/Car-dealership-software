/**
 * FBL-000 schema fingerprint.
 *
 *   DATABASE_URL=... npx tsx scripts/schema-fingerprint.ts [--out <file>]
 *
 * Produces a deterministic JSON description of the public schema — tables, columns,
 * constraints, indexes, triggers, functions — and a SHA-256 over its canonical form.
 * Two databases with the same fingerprint have the same schema SHAPE regardless of how
 * they got there (fresh chain vs upgrade from a fixture), which is what the CI upgrade
 * job compares. Catalog queries only; no pg_dump dependency, so the same script runs
 * identically in CI and locally.
 */
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { closePool, query } from '@dealer/database';

async function fingerprint(): Promise<{ sha256: string; schema: Record<string, unknown> }> {
  const columns = (
    await query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, column_name`)
  ).rows;

  const constraints = (
    await query(`
      SELECT rel.relname AS table_name, con.conname AS name, pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE nsp.nspname = 'public'
       ORDER BY rel.relname, con.conname`)
  ).rows;

  const indexes = (
    await query(`
      SELECT tablename AS table_name, indexname AS name, indexdef AS definition
        FROM pg_indexes
       WHERE schemaname = 'public'
       ORDER BY tablename, indexname`)
  ).rows;

  const triggers = (
    await query(`
      SELECT event_object_table AS table_name, trigger_name, action_timing, event_manipulation, action_statement
        FROM information_schema.triggers
       WHERE trigger_schema = 'public'
       ORDER BY event_object_table, trigger_name, event_manipulation`)
  ).rows;

  const functions = (
    await query(`
      SELECT p.proname AS name, pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
       -- FBL-020-R6 §3 -- THE SORT MUST BE TOTAL, and on a name alone it is not.
       -- pgcrypto installs overloads -- pgp_sym_decrypt(bytea,text) and
       -- pgp_sym_decrypt(bytea,text,text) among them -- which tie on proname, and
       -- PostgreSQL then returns tied rows in whatever order it finds them: physical
       -- order, which differs between two databases holding the SAME schema. The
       -- fresh-versus-upgraded comparison therefore compared a set against a permutation
       -- of itself, and could fail for a reason that is not a schema difference at all.
       -- It did, on this order's drill. The identity arguments make the key unique, so
       -- the comparison is about the schema and nothing else.
       ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)`)
  ).rows;

  // schema_migrations CONTENT is deliberately excluded: a fresh chain and a fixture
  // upgrade legitimately record different filename sets at different times. The shape
  // of the table itself is still fingerprinted like any other.
  const schema = { columns, constraints, indexes, triggers, functions };
  const canonical = JSON.stringify(schema);
  return { sha256: createHash('sha256').update(canonical).digest('hex'), schema };
}

async function main(): Promise<void> {
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;
  const { sha256, schema } = await fingerprint();
  const tableCount = new Set(
    (schema.columns as Array<{ table_name: string }>).map((c) => c.table_name),
  ).size;
  console.log(`schema_fingerprint_sha256=${sha256}`);
  console.log(`tables=${tableCount}`);
  if (outPath !== undefined) {
    writeFileSync(outPath, JSON.stringify({ sha256, ...schema }, null, 2) + '\n');
    console.log(`written=${outPath}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
