import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { EVENT_ORIGIN, type EventVault } from '../scripts/event-demo-accounts';
import { eventPublicDraft } from '../scripts/event-demo-review';
import { eventInterpretationReview, runEventFlow } from '../scripts/event-demo-flow';
import { intentSigningMessage, type PublicIntent } from '../packages/arkiv/src';
import type { Intent } from '../packages/shared/src';
import type { IntentSemantics } from '../packages/matching/src/semantics';

type Journal = NonNullable<Parameters<typeof runEventFlow>[2]['journal']>;
function fixture() {
  const vault: EventVault = { version: 1, origin: EVENT_ORIGIN, createdAt: new Date().toISOString(), wallets: (['krishna', 'viha'] as const).map(label => ({ label, ownerKey: generatePrivateKey(), delegateKey: generatePrivateKey(), accountId: randomUUID(), session: `meeti_session=${(label === 'krishna' ? 'a' : 'b').repeat(64)}`, profileConfirmedAt: new Date().toISOString() })) };
  const records = vault.wallets.map(wallet => ({ wallet, owner: privateKeyToAccount(wallet.ownerKey).address, delegate: privateKeyToAccount(wallet.delegateKey).address, intents: [] as Intent[] }));
  let journal: Journal | undefined;
  let modelRequests = 0, draftRequests = 0, failModel = false, unknownDraft = false;
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    const parsed = new URL(String(url)), cookie = new Headers(options?.headers).get('cookie'), record = records.find(record => record.wallet.session === cookie)!;
    expect(parsed.origin).toBe(EVENT_ORIGIN); expect(options?.redirect).toBe('error'); expect(record).toBeTruthy();
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    const agentName = `networking.event-${record.wallet.label}.users.meeti-demo.eth`;
    if (parsed.pathname === '/api/state') return Response.json({ data: { user: { id: record.wallet.accountId, wallet: record.owner }, profile: { aiConsent: true }, agent: { ensName: agentName, owner: record.owner, delegate: record.delegate, policy: { purpose: 'collaborator', version: 1, paused: false, expiresAt: new Date(Date.now() + 86400000).toISOString() } }, intents: record.intents, integrations: { world: { status: 'deferred' } } } });
    if (parsed.pathname === '/api/intent/structure') {
      modelRequests++; expect(journal?.attempts.at(-1)?.state).toBe('reserved'); expect(body).toEqual({ text: eventPublicDraft(record.wallet.label), providerDisclosureConsent: true });
      if (failModel) throw new Error('fixture transport outcome unknown');
      const semantics: IntentSemantics = { schemaVersion: 1, category: 'collaborator', categoryEvidence: 'collaborate', direction: 'collaborating', directionEvidence: 'want to collaborate', canonicalRole: { value: 'event organizers', sourceQuote: 'event organizers' }, topics: [{ value: 'event', sourceQuote: 'event' }], offers: [], requirements: [], clarificationQuestions: [] };
      const now = new Date().toISOString(); return Response.json({ data: { output: { goal: 'collaborator', summary: body.text, tags: ['event'], semantics }, inference: { requestId: randomUUID(), providerRequestId: 'fixture-only', model: 'fixture-http-model', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, startedAt: now, completedAt: now } } });
    }
    if (parsed.pathname === '/api/intent') {
      draftRequests++; expect(journal?.drafts[record.wallet.label]?.state).toBe('creating');
      const draft: Intent = { id: randomUUID(), version: 1, goal: body.goal, summary: body.summary, tags: body.tags, expiresAt: body.expiresAt, createdAt: new Date().toISOString(), policyVersion: 1, status: 'draft', demoOrigin: true, semantics: body.semantics }; record.intents.push(draft);
      if (unknownDraft) throw new Error('fixture draft response lost'); return Response.json({ data: draft });
    }
    if (parsed.pathname === '/api/intent/publish') {
      expect(Object.keys(body)).toEqual(['intentId']); const draft = record.intents.find(intent => intent.id === body.intentId)!;
      const payload: PublicIntent = { intentId: draft.id, version: draft.version, owner: record.owner, ensAgentRef: agentName, goal: draft.goal, tags: draft.tags, summary: draft.summary, visibility: 'public', optIn: true, schemaVersion: 2, status: 'active', semantics: draft.semantics!, policyVersion: 1, createdAt: draft.createdAt, expiresAt: draft.expiresAt, demoOrigin: true };
      return Response.json({ data: { intent: payload, signingMessage: intentSigningMessage(payload) } });
    }
    throw new Error('Forbidden event fixture endpoint');
  });
  const save = (next: Journal) => { journal = structuredClone(next); };
  return { vault, fetcher, save, current: () => journal, counts: () => ({ modelRequests, draftRequests }), failModel: () => { failModel = true; }, unknownDraft: () => { unknownDraft = true; } };
}
describe('event intake stages with fixture HTTP, not live model evidence', () => {
  it('allows at most two model transmissions and preserves receipts across restart', async () => {
    const f = fixture(); await expect(runEventFlow('interpret', f.vault, { save: f.save, fetcher: f.fetcher })).rejects.toMatchObject({ code: 'EVENT_INTERPRETATION_REQUIRES_EXPLICIT_TWO_CALL_LIMIT' });
    const first = await runEventFlow('interpret', f.vault, { save: f.save, fetcher: f.fetcher, allowModelCalls: 2 }); expect(first.report.newModelCalls).toBe(2); expect(f.counts().modelRequests).toBe(2);
    const second = await runEventFlow('interpret', f.vault, { journal: f.current(), save: f.save, fetcher: f.fetcher, allowModelCalls: 2 }); expect(second.report.newModelCalls).toBe(0); expect(f.counts().modelRequests).toBe(2);
    expect(eventInterpretationReview(second.journal).records).toHaveLength(2);
  });
  it('never repeats an unknown model request after a process restart', async () => {
    const f = fixture(); f.failModel(); await expect(runEventFlow('interpret', f.vault, { save: f.save, fetcher: f.fetcher, allowModelCalls: 2 })).rejects.toThrow();
    expect(f.current()?.attempts).toMatchObject([{ label: 'krishna', state: 'failed_or_unknown' }]);
    await expect(runEventFlow('interpret', f.vault, { journal: f.current(), save: f.save, fetcher: f.fetcher, allowModelCalls: 2 })).rejects.toMatchObject({ code: 'EVENT_UNCERTAIN_INTERPRETATION_STOP_NO_RETRY' }); expect(f.counts().modelRequests).toBe(1);
  });
  it('requires exact owner review before real drafts and exports actual unsigned public previews', async () => {
    const f = fixture(), interpreted = await runEventFlow('interpret', f.vault, { save: f.save, fetcher: f.fetcher, allowModelCalls: 2 });
    await expect(runEventFlow('draft', f.vault, { journal: f.current(), save: f.save, fetcher: f.fetcher, expectedInterpretationDigest: '0'.repeat(64) })).rejects.toMatchObject({ code: 'EXACT_EVENT_INTERPRETATION_OWNER_REVIEW_REQUIRED' }); expect(f.counts().draftRequests).toBe(0);
    const expectedInterpretationDigest = 'interpretationDigest' in interpreted.report ? interpreted.report.interpretationDigest as string : '';
    await runEventFlow('draft', f.vault, { journal: f.current(), save: f.save, fetcher: f.fetcher, expectedInterpretationDigest });
    const preview = await runEventFlow('preview', f.vault, { journal: f.current(), save: f.save, fetcher: f.fetcher, expectedInterpretationDigest });
    expect(f.counts()).toEqual({ modelRequests: 2, draftRequests: 2 }); expect(preview.report).toMatchObject({ status: 'EXACT_UNSIGNED_ARKIV_PUBLIC_PAYLOAD_REVIEW', publicSignatures: 0, broadcasts: 0 });
    expect(preview.journal.previews.krishna?.owner).not.toBe(preview.journal.previews.viha?.owner);
    expect(preview.journal.previews.krishna?.intentId).toBe(f.current()?.drafts.krishna?.intentId);
  });
  it('recovers an actually saved draft after a lost response without creating another draft', async () => {
    const f = fixture(), interpreted = await runEventFlow('interpret', f.vault, { save: f.save, fetcher: f.fetcher, allowModelCalls: 2 });
    const expectedInterpretationDigest = 'interpretationDigest' in interpreted.report ? interpreted.report.interpretationDigest as string : ''; f.unknownDraft();
    await expect(runEventFlow('draft', f.vault, { journal: f.current(), save: f.save, fetcher: f.fetcher, expectedInterpretationDigest })).rejects.toThrow(); expect(f.counts().draftRequests).toBe(1);
    await expect(runEventFlow('draft', f.vault, { journal: f.current(), save: f.save, fetcher: f.fetcher, expectedInterpretationDigest })).rejects.toThrow();
    expect(f.current()?.drafts.krishna?.state).toBe('confirmed'); expect(f.counts().draftRequests).toBe(2);
    await runEventFlow('draft', f.vault, { journal: f.current(), save: f.save, fetcher: f.fetcher, expectedInterpretationDigest }); expect(f.counts().draftRequests).toBe(2);
  });
});
