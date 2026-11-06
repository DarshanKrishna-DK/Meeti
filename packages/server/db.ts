import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decrypt, encrypt } from './crypto';
import type { Agent, Intent, Policy, Profile } from '../shared/src';

export type UserRow = { id: string; email: string; password_hash: string; wallet: string | null; profile: string; created_at: string };
export type IntentRow = { id: string; user_id: string; version: number; status: string; data: string };
export type ProposalData = {
  leftIntent: Intent; rightIntent: Intent; leftPolicy: Policy; rightPolicy: Policy;
  leftAgent: string; rightAgent: string; summary: string; compatibility: unknown;
  leftProfileDigest?: string; rightProfileDigest?: string;
  exchanges: { speaker: string; content: string; allowed: boolean; reason?: string }[];
  createdAt: string;
};
export type ProposalRow = { id: string; left_user: string; right_user: string; pair_key: string; status: string; digest: string; data: string };
const schemaVersion = 5;
const cache = globalThis as typeof globalThis & { meetiDb?: { path: string; db: DatabaseSync; schemaVersion?: number } };
export function db(): DatabaseSync {
  const path = resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH || '.local-data/meeti.sqlite');
  if (cache.meetiDb?.path === path && cache.meetiDb.schemaVersion === schemaVersion) return cache.meetiDb.db;
  mkdirSync(dirname(path), { recursive: true });
  const connection = cache.meetiDb?.path === path ? cache.meetiDb.db : new DatabaseSync(path);
  connection.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  connection.exec(readFileSync(resolve('migrations/001_initial.sql'), 'utf8'));
  connection.exec(readFileSync(resolve('migrations/002_onboarding.sql'), 'utf8'));
  connection.exec(readFileSync(resolve('migrations/003_agent_runs.sql'), 'utf8'));
  connection.exec(readFileSync(resolve('migrations/004_context.sql'), 'utf8'));
  connection.exec(readFileSync(resolve('migrations/005_policy_history.sql'), 'utf8'));
  cache.meetiDb = { path, db: connection, schemaVersion };
  return connection;
}
export function atomic<T>(fn: () => T): T {
  const connection = db();
  connection.exec('BEGIN IMMEDIATE');
  try { const result = fn(); connection.exec('COMMIT'); return result; }
  catch (error) { connection.exec('ROLLBACK'); throw error; }
}
export function user(id: string): UserRow | undefined { return db().prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow | undefined; }
export function profile(id: string): Profile {
  const row = user(id);
  if (!row) throw new Error('Account is unavailable.');
  return decrypt<Profile>(row.profile, `profile:${id}`);
}
export function agent(id: string): Agent | null {
  const row = db().prepare('SELECT data FROM agents WHERE user_id=?').get(id) as { data: string } | undefined;
  return row ? decrypt<Agent>(row.data, `agent:${id}`) : null;
}
export function saveAgent(id: string, value: Agent): void {
  const save = () => {
    db().prepare('INSERT INTO agents(id,user_id,data) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data').run(value.id, id, encrypt(value, `agent:${id}`));
    db().prepare('INSERT INTO policy_history(user_id,version,data,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,version) DO NOTHING')
      .run(id, value.policy.version, encrypt({ ensName: value.ensName, delegate: value.delegate, persona: value.persona, policy: value.policy }, `policy-history:${id}:${value.policy.version}`), new Date().toISOString());
  };
  if (db().isTransaction) save(); else atomic(save);
}
export function intent(id: string): { userId: string; value: Intent } | null {
  const row = db().prepare('SELECT * FROM intents WHERE id=?').get(id) as IntentRow | undefined;
  return row ? { userId: row.user_id, value: decrypt<Intent>(row.data, `intent:${row.id}`) } : null;
}
export function saveIntent(userId: string, value: Intent): void {
  db().prepare('INSERT INTO intents(id,user_id,version,status,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,status=excluded.status,data=excluded.data').run(value.id, userId, value.version, value.status, encrypt(value, `intent:${value.id}`));
}
export function proposal(id: string): { row: ProposalRow; value: ProposalData } | null {
  const row = db().prepare('SELECT * FROM proposals WHERE id=?').get(id) as ProposalRow | undefined;
  return row ? { row, value: decrypt<ProposalData>(row.data, `proposal:${id}`) } : null;
}
export function audit(userId: string, action: string, outcome: string, detail: string): void {
  db().prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)').run(randomUUID(), userId, action, outcome, detail.slice(0, 500), new Date().toISOString());
}
export function closeDatabase(): void { cache.meetiDb?.db.close(); delete cache.meetiDb; }
