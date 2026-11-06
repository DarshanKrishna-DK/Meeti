import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { db as localDatabase } from './db';
import { decrypt, encrypt } from './crypto';
import { postgresSql } from './store-sql';
import type { Agent, Intent, Profile } from '../shared/src';
import type { UserRow, IntentRow, ProposalData, ProposalRow } from './db';
export type { UserRow, IntentRow, ProposalData, ProposalRow } from './db';

type Row = Record<string, unknown>;
type Transaction = { kind: 'sqlite'; key: string; connection: DatabaseSync; active: boolean; savepoint: number }
  | { kind: 'postgres'; key: string; connection: PoolClient; active: boolean; savepoint: number };
const context = new AsyncLocalStorage<Transaction>();
let localTail: Promise<void> = Promise.resolve();
let poolState: { key: string; pool: Pool } | undefined;
const lockId = '556794915136664453';

function configuration() {
  const provider = process.env.DATABASE_PROVIDER || 'sqlite';
  if (!['sqlite', 'postgres'].includes(provider)) throw new Error('database_provider_invalid');
  if (provider === 'sqlite') return { kind: 'sqlite' as const, key: resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH || '.local-data/meeti.sqlite') };
  const key = process.env.SUPABASE_DATABASE_URL;
  if (!key) throw new Error('database_connection_not_configured');
  return { kind: 'postgres' as const, key };
}
function pool(key: string) {
  if (poolState?.key === key) return poolState.pool;
  if (poolState) throw new Error('database_configuration_changed_restart_required');
  const url = new URL(key);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password) throw new Error('database_connection_invalid');
  for (const option of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(option);
  const value = new Pool({ connectionString: url.toString(), max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000,
    ssl: { rejectUnauthorized: true, ...(process.env.SUPABASE_DATABASE_CA ? { ca: process.env.SUPABASE_DATABASE_CA } : {}) },
    options: '-c search_path=pg_catalog,meeti_private -c statement_timeout=15000 -c lock_timeout=10000',
  });
  value.on('error', () => { console.warn('database_idle_connection_unavailable'); });
  poolState = { key, pool: value }; return value;
}
async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const previous = localTail; let release!: () => void;
  localTail = new Promise<void>(done => { release = done; });
  await previous;
  try { return await operation(); } finally { release(); }
}
function activeTransaction() {
  const value = context.getStore();
  if (value && (!value.active || value.key !== configuration().key)) throw new Error('database_transaction_scope_expired');
  return value;
}
async function statement(kind: 'get' | 'all' | 'run', sql: string, parameters: unknown[]): Promise<Row | Row[] | { changes: number } | undefined> {
  const config = configuration(), transaction = activeTransaction();
  if (config.kind === 'postgres' && !transaction && kind === 'run') return atomic(() => statement(kind, sql, parameters));
  const execute = async () => {
    if (config.kind === 'sqlite') {
      const connection = transaction?.kind === 'sqlite' ? transaction.connection : localDatabase();
      const query = connection.prepare(sql), args = parameters as SQLInputValue[];
      if (kind === 'get') return query.get(...args);
      if (kind === 'all') return query.all(...args);
      return { changes: Number(query.run(...args).changes) };
    }
    const connection = transaction?.kind === 'postgres' ? transaction.connection : pool(config.key);
    try {
      const result = await connection.query(postgresSql(sql), parameters);
      // Epoch milliseconds fit safely in Number. The synthetic ordering column is not an application field.
      const rows = result.rows.map((row: Row) => {
        delete row.__row_order;
        if (typeof row.reset_at === 'string' && /^\d+$/.test(row.reset_at)) row.reset_at = Number(row.reset_at);
        return row;
      });
      return kind === 'get' ? rows[0] : kind === 'all' ? rows : { changes: result.rowCount || 0 };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'unknown';
      throw new Error(`database_statement_failed_${code}`);
    }
  };
  return config.kind === 'sqlite' && !transaction ? exclusive(execute) : execute();
}
export function db() {
  return {
    get isTransaction() { return Boolean(activeTransaction()); },
    prepare(sql: string) {
      return {
        get: (...parameters: unknown[]) => statement('get', sql, parameters) as Promise<Row | undefined>,
        all: (...parameters: unknown[]) => statement('all', sql, parameters) as Promise<Row[]>,
        run: (...parameters: unknown[]) => statement('run', sql, parameters) as Promise<{ changes: number }>,
      };
    },
  };
}
/** A checked-out connection remains bound throughout the awaited transaction callback. */
export async function atomic<T>(operation: () => T | Promise<T>): Promise<T> {
  const config = configuration(), parent = activeTransaction();
  if (parent) {
    const name = `meeti_sp_${++parent.savepoint}`;
    const control = async (sql: string) => { if (parent.kind === 'sqlite') parent.connection.exec(sql); else await parent.connection.query(sql); };
    await control(`SAVEPOINT ${name}`);
    try { const result = await operation(); await control(`RELEASE SAVEPOINT ${name}`); return result; }
    catch (error) { await control(`ROLLBACK TO SAVEPOINT ${name}`); await control(`RELEASE SAVEPOINT ${name}`); throw error; }
  }
  const execute = async () => {
    const connection = config.kind === 'sqlite' ? localDatabase() : await pool(config.key).connect();
    const scope = { kind: config.kind, key: config.key, connection, active: true, savepoint: 0 } as Transaction;
    const control = async (sql: string) => { if (scope.kind === 'sqlite') scope.connection.exec(sql); else await scope.connection.query(sql); };
    try {
      await control(config.kind === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
      // Match the single-writer boundary across independent hosted processes. Every standalone write also takes this lock.
      if (scope.kind === 'postgres') await scope.connection.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockId]);
      const result = await context.run(scope, operation);
      await control('COMMIT'); return result;
    } catch (error) {
      try { await control('ROLLBACK'); } catch { /* Preserve the original failure without revealing database details. */ }
      throw error;
    } finally { scope.active = false; if (scope.kind === 'postgres') scope.connection.release(); }
  };
  return config.kind === 'sqlite' ? exclusive(execute) : execute();
}
export async function user(id: string) { return await db().prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow | undefined; }
export async function profile(id: string): Promise<Profile> { const row = await user(id); if (!row) throw new Error('Account is unavailable.'); return decrypt<Profile>(row.profile, `profile:${id}`); }
export async function agent(id: string): Promise<Agent | null> {
  const row = await db().prepare('SELECT data FROM agents WHERE user_id=?').get(id) as { data: string } | undefined;
  return row ? decrypt<Agent>(row.data, `agent:${id}`) : null;
}
export async function saveAgent(id: string, value: Agent): Promise<void> {
  await atomic(async () => {
    await db().prepare('INSERT INTO agents(id,user_id,data) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data').run(value.id, id, encrypt(value, `agent:${id}`));
    await db().prepare('INSERT INTO policy_history(user_id,version,data,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,version) DO NOTHING')
      .run(id, value.policy.version, encrypt({ ensName: value.ensName, delegate: value.delegate, persona: value.persona, policy: value.policy }, `policy-history:${id}:${value.policy.version}`), new Date().toISOString());
  });
}
export async function intent(id: string): Promise<{ userId: string; value: Intent } | null> {
  const row = await db().prepare('SELECT * FROM intents WHERE id=?').get(id) as IntentRow | undefined;
  return row ? { userId: row.user_id, value: decrypt<Intent>(row.data, `intent:${row.id}`) } : null;
}
export async function saveIntent(userId: string, value: Intent): Promise<void> {
  await db().prepare('INSERT INTO intents(id,user_id,version,status,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,status=excluded.status,data=excluded.data').run(value.id, userId, value.version, value.status, encrypt(value, `intent:${value.id}`));
}
export async function proposal(id: string): Promise<{ row: ProposalRow; value: ProposalData } | null> {
  const row = await db().prepare('SELECT * FROM proposals WHERE id=?').get(id) as ProposalRow | undefined;
  return row ? { row, value: decrypt<ProposalData>(row.data, `proposal:${id}`) } : null;
}
export async function audit(userId: string, action: string, outcome: string, detail: string): Promise<void> {
  await db().prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)').run(randomUUID(), userId, action, outcome, detail.slice(0, 500), new Date().toISOString());
}
export async function closeStore(): Promise<void> { const state = poolState; poolState = undefined; if (state) await state.pool.end(); }
