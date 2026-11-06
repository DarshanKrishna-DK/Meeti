import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, type Hex } from 'viem';
import { canonicalIntent } from '../packages/arkiv/src';
import { acquireRevisionLock, assertOnlyReviewedRevision, assertRevisionApproval, correctedIntent, correctionQuote } from '../scripts/demo-intent-revision';
import { assertAdmissionDeadline, broadcastOnce, type Entry } from '../scripts/execute-demo-arkiv';
function previous() {
  return canonicalIntent({ intentId: '00000000-0000-4000-8000-000000000001', ensAgentRef: 'networking.demo-recruiter.users.meeti-demo.eth', goal: 'collaborator', tags: ['workshop'], summary: `Fictional TEST DATA. ${correctionQuote}`, visibility: 'public', optIn: true, schemaVersion: 2, status: 'active', owner: '0x1111111111111111111111111111111111111111', version: 1, policyVersion: 2, createdAt: '2026-11-07T00:00:00.000Z', expiresAt: '2026-11-08T00:00:00.000Z', demoOrigin: true,
    semantics: { schemaVersion: 1, category: 'collaborator', categoryEvidence: correctionQuote, direction: 'collaborating', directionEvidence: correctionQuote, canonicalRole: null, topics: [], offers: [], requirements: [{ kind: 'skill', value: 'learning guides', sourceQuote: correctionQuote, strength: 'mandatory' }], clarificationQuestions: [] } });
}
describe('explicit fictional owner revision, not new inference', () => {
  it('uses one exclusive lock across prepare and execution, and never removes a stale or competing lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeti-revision-lock-')), path = join(dir, 'shared.lock');
    const metadata = { mode: 'prepare', originalReviewSha256: 'a'.repeat(64), revisionReviewSha256: null };
    try {
      const release = acquireRevisionLock(path, metadata), first = readFileSync(path, 'utf8');
      try { expect(JSON.parse(first)).toMatchObject({ pid: process.pid, ...metadata }); expect(() => acquireRevisionLock(path, { ...metadata, mode: 'execute' })).toThrow(); expect(readFileSync(path, 'utf8')).toBe(first); }
      finally { release(); }
      const releaseNext = acquireRevisionLock(path, { ...metadata, mode: 'reconcile' }); releaseNext();
      writeFileSync(path, 'operator must review stale lock'); expect(() => acquireRevisionLock(path, metadata)).toThrow(); expect(readFileSync(path, 'utf8')).toBe('operator must review stale lock');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('increments the same logical ID, corrects only the reviewed strength, and never mutates the frozen source', () => {
    const original = previous(), frozen = JSON.stringify(original), next = correctedIntent(original, '2026-11-07T00:01:00.000Z');
    expect(next.intentId).toBe(original.intentId); expect(next.version).toBe(2); expect(next.expiresAt).toBe(original.expiresAt); expect(next.semantics.requirements[0].strength).toBe('preferred'); expect(JSON.stringify(original)).toBe(frozen);
    expect(() => assertOnlyReviewedRevision(original, next)).not.toThrow();
  });
  it.each(['intentId', 'summary', 'expiresAt', 'owner'] as const)('rejects any additional public %s delta', field => {
    const original = previous(), next = correctedIntent(original, '2026-11-07T00:01:00.000Z');
    if (field === 'expiresAt') next.expiresAt = '2026-11-08T01:00:00.000Z'; else if (field === 'owner') next.owner = '0x2222222222222222222222222222222222222222'; else next[field] = 'changed';
    expect(() => assertOnlyReviewedRevision(original, next)).toThrow();
  });
  it('rejects new semantic changes, duplicate matching requirements and repeated version increments', () => {
    const original = previous(), next = correctedIntent(original, '2026-11-07T00:01:00.000Z'); next.semantics.topics.push({ value: 'invented', sourceQuote: 'invented' }); expect(() => assertOnlyReviewedRevision(original, next)).toThrow('unapproved_delta');
    original.semantics.requirements.push({ ...original.semantics.requirements[0] }); expect(() => correctedIntent(original, next.createdAt)).toThrow('single_owner_correction');
    expect(() => correctedIntent({ ...previous(), version: 2 }, next.createdAt)).toThrow('revision_one');
  });
  it('rejects expired timestamps, an unapproved hash, wrong chain or any increased fee cap', () => {
    const original = previous(); expect(() => assertOnlyReviewedRevision(original, correctedIntent(original, original.createdAt))).toThrow('timestamp_invalid');
    const approval = { authorized: true, reviewSha256: 'a'.repeat(64), chainId: 7794095, maximumFeeWei: '1000000000000000', approvedAt: '2026-11-07T00:00:00.000Z' };
    expect(() => assertRevisionApproval('a'.repeat(64), approval, Date.parse('2026-11-07T00:01:00Z'))).not.toThrow();
    for (const changed of [{ ...approval, reviewSha256: 'b'.repeat(64) }, { ...approval, chainId: 1 }, { ...approval, maximumFeeWei: '1000000000000001' }]) expect(() => assertRevisionApproval('a'.repeat(64), changed)).toThrow('exact_revision_approval');
    expect(() => assertAdmissionDeadline({ kind: 'publication', reviewExpiresAt: '2026-11-07T00:01:00Z', quoteExpiresAt: '2026-11-07T00:01:00Z' }, Date.parse('2026-11-07T00:01:00Z'))).toThrow('expired');
  });
  it('reuses one-shot admission which persists before send and prevents replay after timeout', async () => {
    const raw = '0x1234' as Hex, entry: Entry = { id: 'revision', label: 'demo-recruiter', kind: 'publication', state: 'signed', raw, hash: keccak256(raw), prepared: { expiresAt: '2026-11-07T01:00:00Z' } as never };
    const order: string[] = [], send = vi.fn(async () => { order.push('send'); throw new Error('fixture_timeout'); });
    await expect(broadcastOnce(entry, '2026-11-07T01:00:00Z', () => { order.push('durable'); }, send, () => Date.parse('2026-11-07T00:10:00Z'))).rejects.toThrow('fixture_timeout'); expect(order).toEqual(['durable', 'send']);
    await expect(broadcastOnce(entry, '2026-11-07T01:00:00Z', () => {}, send)).rejects.toThrow('cannot_be_broadcast_again'); expect(send).toHaveBeenCalledOnce();
  });
});
