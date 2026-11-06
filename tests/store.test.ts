import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomic, db } from '../packages/server/store';
import { closeDatabase } from '../packages/server/db';
import { postgresSql } from '../packages/server/store-sql';

// Local transaction and SQL translation fixtures. These are not live Postgres evidence.
let directory: string;
beforeEach(() => {
  closeDatabase(); directory = mkdtempSync(join(tmpdir(), 'meeti-store-'));
  vi.stubEnv('DATABASE_PROVIDER', 'sqlite'); vi.stubEnv('DATABASE_PATH', join(directory, 'fixture.sqlite'));
});
afterEach(() => { closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const write = (id: string) => db().prepare('INSERT INTO rate_limits VALUES(?,?,?)').run(id, 1, Date.now());

describe('awaited persistence transactions', () => {
  it('rolls back earlier writes when a later awaited operation fails', async () => {
    await expect(atomic(async () => { await write('first'); await Promise.resolve(); throw new Error('abort'); })).rejects.toThrow('abort');
    expect(await db().prepare('SELECT * FROM rate_limits').all()).toEqual([]);
  });
  it('keeps outside writes out of an in-progress transaction rollback', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const ready = new Promise<void>(done => { entered = done; });
    const transaction = atomic(async () => { await write('rolled-back'); entered(); await gate; throw new Error('abort'); });
    const rejected = expect(transaction).rejects.toThrow('abort');
    await ready;
    const outside = write('outside'); release(); await rejected; await outside;
    expect(await db().prepare('SELECT bucket FROM rate_limits').all()).toEqual([{ bucket: 'outside' }]);
  });
  it('rolls back only a failed nested savepoint when its parent handles the error', async () => {
    await atomic(async () => {
      await write('parent');
      await expect(atomic(async () => { await write('child'); throw new Error('child-abort'); })).rejects.toThrow('child-abort');
      await write('after');
    });
    expect(await db().prepare('SELECT bucket FROM rate_limits ORDER BY bucket').all()).toEqual([{ bucket: 'after' }, { bucket: 'parent' }]);
  });
  it('rejects detached work using a completed transaction scope', async () => {
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    let detached!: Promise<unknown>;
    await atomic(async () => { detached = gate.then(() => write(randomUUID())); });
    const rejected = expect(detached).rejects.toThrow('database_transaction_scope_expired'); release(); await rejected;
  });
  it('does not enable remote persistence solely because a credential exists', async () => {
    vi.stubEnv('DATABASE_PROVIDER', ''); vi.stubEnv('SUPABASE_DATABASE_URL', 'postgresql://invalid:invalid@invalid.invalid/db');
    await write('local'); expect(await db().prepare('SELECT bucket FROM rate_limits').get()).toEqual({ bucket: 'local' });
  });
});
describe('fixed SQL dialect conversion', () => {
  it('keeps quoted literals intact and binds placeholders independently of row order', () => {
    expect(postgresSql("SELECT '?' AS value, 'rowid' AS literal FROM audit WHERE user_id=? ORDER BY audit.rowid DESC"))
      .toBe("SELECT '?' AS value, 'rowid' AS literal FROM audit WHERE user_id=$1 ORDER BY audit.__row_order DESC");
  });
  it('adds explicit original columns and preserves conflict-safe inserts', () => {
    expect(postgresSql('INSERT OR IGNORE INTO blocks VALUES(?,?);'))
      .toBe('INSERT INTO blocks (user_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING');
    expect(postgresSql('UPDATE users SET profile=? WHERE id=?')).toBe('UPDATE users SET profile=$1 WHERE id=$2');
    expect(() => postgresSql('INSERT INTO unknown_table VALUES(?)')).toThrow('database_unknown_insert_table');
  });
});
