import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { decrypt } from '../packages/server/crypto';
import { atomic, closeStore, db } from '../packages/server/store';
import { storeColumns } from '../packages/server/store-columns';

const excluded = new Set(['sessions', 'challenges', 'wallet_auth_challenges', 'rate_limits', 'agent_runs', 'discovery_jobs', 'discovery_preferences', 'agent_tasks', 'inference_budgets', 'inference_attempts']);
const maximumRows = 100000, maximumSnapshotBytes = 64 * 1024 * 1024;
type Cell = string | number | null;
type SnapshotTable = { name: string; columns: readonly string[]; rows: Cell[][] };
class MigrationError extends Error { constructor(readonly code: string) { super(code); } }
function deny(code: string): never { throw new MigrationError(code); }

async function snapshot(source: string) {
  const workspace = await realpath(process.cwd()), base = resolve(workspace, '.local-data');
  if ((await lstat(base)).isSymbolicLink() || await realpath(base) !== base) deny('source_directory_scope');
  const requested = resolve(source), stat = await lstat(requested), path = await realpath(requested), within = relative(base, path);
  if (!stat.isFile() || stat.isSymbolicLink() || !within || within.startsWith('..') || isAbsolute(within)) deny('source_file_scope');
  const files = (await readdir(resolve('migrations'))).filter(file => /^00[1-9]_[a-z_]+\.sql$/.test(file)).sort();
  if (files.length !== 9) deny('source_schema_version');
  const order: string[] = [], schemaHashes: string[] = [];
  for (const file of files) {
    const sql = await readFile(resolve('migrations', file), 'utf8');
    schemaHashes.push(createHash('sha256').update(sql).digest('hex'));
    for (const match of sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)/gi)) if (!order.includes(match[1])) order.push(match[1]);
  }
  if (order.some(name => !storeColumns[name]) || Object.keys(storeColumns).some(name => !order.includes(name))) deny('source_schema_mapping');
  const connection = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    connection.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000; BEGIN;');
    const present = new Set((connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name));
    if ([...present].some(name => !storeColumns[name]) || order.filter(name => !excluded.has(name)).some(name => !present.has(name))) deny('source_schema_unknown_or_missing');
    const integrity = connection.prepare('PRAGMA quick_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok' || connection.prepare('PRAGMA foreign_key_check').all().length) deny('source_integrity');
    const tables: SnapshotTable[] = [], counts: Record<string, { rows: number; copy: boolean }> = {};
    let rowCount = 0, bytes = 0;
    for (const name of order) {
      const columns = storeColumns[name];
      if (!present.has(name)) { counts[name] = { rows: 0, copy: false }; continue; }
      const total = connection.prepare(`SELECT COUNT(*) AS total FROM ${name}`).get() as { total: number };
      counts[name] = { rows: total.total, copy: !excluded.has(name) };
      if (excluded.has(name)) continue;
      if (rowCount + total.total > maximumRows) deny('source_snapshot_bounds');
      const actualColumns = connection.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name);
      if (actualColumns.length !== columns.length || actualColumns.some((column, index) => column !== columns[index])) deny('source_column_mapping');
      const rows: Cell[][] = [];
      for (const record of connection.prepare(`SELECT ${columns.join(',')} FROM ${name} ORDER BY rowid`).iterate()) {
        const cells = columns.map(column => {
          const value = record[column];
          if (value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) deny('source_cell_type');
          return value as Cell;
        });
        bytes += Buffer.byteLength(JSON.stringify(cells));
        if (bytes > maximumSnapshotBytes) deny('source_snapshot_bounds');
        rows.push(cells);
      }
      rowCount += rows.length; tables.push({ name, columns, rows });
    }
    const table = (name: string) => tables.find(value => value.name === name)!;
    const value = (table: SnapshotTable, row: Cell[], column: string) => row[table.columns.indexOf(column)];
    const users = table('users');
    if (!users.rows.length || !/^[a-f0-9]{64}$/i.test(process.env.DATA_ENCRYPTION_KEY || '')) deny('source_profile_key_required');
    for (const row of users.rows) {
      try {
        const profile = decrypt<unknown>(String(value(users, row, 'profile')), `profile:${value(users, row, 'id')}`);
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) deny('source_profile_decryption');
      } catch { deny('source_profile_decryption'); }
    }
    const qualifications = table('qualifications');
    for (const row of qualifications.rows) {
      const token = value(qualifications, row, 'lease_token'), until = value(qualifications, row, 'lease_until'), state = value(qualifications, row, 'state');
      const expiry = typeof until === 'string' ? Date.parse(until) : NaN;
      if ((token !== null || state === 'running') && (!Number.isFinite(expiry) || expiry > Date.now())) deny('source_active_qualification_lease');
    }
    const operations = table('operations');
    if (operations.rows.some(row => ['prepared', 'submitted'].includes(String(value(operations, row, 'state'))) || String(value(operations, row, 'state')).startsWith('storage_'))) deny('source_unresolved_operation');
    const claims = table('namespace_claims');
    if (claims.rows.some(row => ['prepared', 'submitted'].includes(String(value(claims, row, 'state'))))) deny('source_unresolved_namespace_claim');
    const sourceName = relative(workspace, path).replaceAll('\\', '/');
    const digest = createHash('sha256').update(JSON.stringify({ format: 'meeti-private-snapshot-v1', source: sourceName, schemaHashes, counts, tables })).digest('hex');
    connection.exec('ROLLBACK;');
    return { digest, counts, tables, rowCount };
  } finally { connection.close(); }
}

function tableDigest(table: SnapshotTable) { return createHash('sha256').update(JSON.stringify({ columns: table.columns, rows: table.rows })).digest('hex'); }

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { source: { type: 'string' }, review: { type: 'boolean' }, execute: { type: 'boolean' }, 'expected-digest': { type: 'string' } }, strict: true, allowPositionals: false });
  if (!values.source || (values.review && values.execute) || (!values.execute && values['expected-digest']) || (values.execute && !/^[a-f0-9]{64}$/i.test(values['expected-digest'] || ''))) deny('arguments');
  const data = await snapshot(values.source);
  if (!values.execute) { console.log(JSON.stringify({ mode: 'review', digest: data.digest, counts: data.counts }, null, 2)); return; }
  if (data.digest !== values['expected-digest']) deny('review_digest_changed');
  if (process.env.DATABASE_PROVIDER !== 'postgres' || !process.env.SUPABASE_DATABASE_URL) deny('postgres_target_required');
  await atomic(async () => {
    for (const table of data.tables) {
      const count = await db().prepare(`SELECT COUNT(*) AS total FROM ${table.name}`).get();
      if (!count || Number(count.total) !== 0) deny('target_not_empty');
    }
    for (const table of data.tables) {
      const sql = `INSERT INTO ${table.name}(${table.columns.join(',')}) VALUES(${table.columns.map(() => '?').join(',')})`;
      for (const row of table.rows) {
        const written = await db().prepare(sql).run(...row as SQLInputValue[]);
        if (written.changes !== 1) deny('target_insert_count');
      }
    }
    for (const table of data.tables) {
      const records = await db().prepare(`SELECT ${table.columns.join(',')} FROM ${table.name} ORDER BY rowid`).all();
      const rows = records.map(record => table.columns.map(column => record[column] as Cell));
      if (records.length !== table.rows.length || tableDigest({ ...table, rows }) !== tableDigest(table)) deny('target_readback_mismatch');
    }
  });
  console.log(JSON.stringify({ mode: 'executed', digest: data.digest, counts: data.counts }, null, 2));
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ error: error instanceof MigrationError ? error.code : 'private_migration_failed_no_private_diagnostics_logged' }));
  process.exitCode = 1;
} finally { await closeStore().catch(() => {}); }
