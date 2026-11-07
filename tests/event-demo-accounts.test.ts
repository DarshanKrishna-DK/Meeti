import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { accountReview, createEventAccounts, EVENT_ORIGIN, eventProfile, eventReviewDigest, type EventVault } from '../scripts/event-demo-accounts';

function fixture() {
  const value: EventVault = { version: 1, origin: EVENT_ORIGIN, createdAt: new Date().toISOString(), wallets: ['krishna', 'viha'].map(label => ({ label: label as 'krishna' | 'viha', ownerKey: generatePrivateKey(), delegateKey: generatePrivateKey() })) };
  const accounts = value.wallets.map(wallet => ({ address: privateKeyToAccount(wallet.ownerKey).address, id: randomUUID(), wallet, profile: { displayName: '', headline: '', bio: '', offering: '', seeking: '', tags: [], contact: '', employer: '', publicFields: [], aiConsent: false } as ReturnType<typeof eventProfile> }));
  let active = accounts[0];
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    const target = new URL(String(url)); expect(target.origin).toBe(EVENT_ORIGIN); expect(options?.redirect).toBe('error');
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    if (target.pathname === '/api/health') return Response.json({ data: { storage: 'postgres', integrations: { world: { status: 'deferred' } } } });
    if (target.pathname === '/api/auth/wallet/challenge') {
      active = accounts.find(account => account.address === body.address)!;
      const id = randomUUID(), issuedAt = new Date(), expirationTime = new Date(issuedAt.getTime() + 300000);
      return Response.json({ data: { id, address: active.address, chainId: 11155111, message: createSiweMessage({ address: active.address, chainId: 11155111, domain: new URL(EVENT_ORIGIN).host, uri: EVENT_ORIGIN, version: '1', nonce: randomBytes(32).toString('hex'), issuedAt, expirationTime, requestId: id, statement: 'Sign in to Meeti. This signature does not authorize transactions or public disclosure.' }) } }, { headers: { 'set-cookie': `meeti_wallet_flow=${'a'.repeat(64)}; HttpOnly` } });
    }
    if (target.pathname === '/api/auth/wallet/verify') return Response.json({ data: { id: active.id, wallet: active.address } }, { headers: { 'set-cookie': `meeti_session=${'b'.repeat(64)}; HttpOnly` } });
    if (target.pathname === '/api/profile') { active.profile = body; return Response.json({ data: body }); }
    if (target.pathname === '/api/state') return Response.json({ data: { user: { id: active.id, wallet: active.address }, profile: active.profile, agent: null, intents: [], proposals: [], rooms: [] } });
    throw new Error('Forbidden endpoint');
  });
  return { value, accounts, fetcher };
}
describe('reviewed fictional event accounts with HTTP fixtures', () => {
  it('reviews distinct owner and delegated keys without exposing secrets or invented event terms', () => {
    const { value } = fixture(), review = accountReview(value);
    expect(new Set(review.accounts.flatMap(account => [account.owner, account.delegate])).size).toBe(4);
    expect(review.accounts.map(account => account.profile.displayName)).toEqual(['Krishna', 'Viha']);
    for (const account of review.accounts) expect(account.profile).toMatchObject({ location: '', timezone: '', availability: '', publicFields: [], contact: '', employer: '' });
    for (const item of value.wallets) { expect(JSON.stringify(review)).not.toContain(item.ownerKey); expect(JSON.stringify(review)).not.toContain(item.delegateKey); }
  });
  it('only signs exact nonce-bound authentication and stores reviewed private profiles with genuine read-back', async () => {
    const { value, fetcher, accounts } = fixture(), save = vi.fn();
    const result = await createEventAccounts(value, { expectedReviewDigest: eventReviewDigest(accountReview(value)), save, fetcher });
    expect(result).toMatchObject({ fictional: true, humanVerified: false, modelCalls: 0, publicIntentSignatures: 0, chainTransactions: 0 });
    expect(new Set(result.accounts.map(account => account.accountId)).size).toBe(2); expect(save).toHaveBeenCalledTimes(4);
    expect(accounts.map(account => account.profile)).toEqual([eventProfile('krishna'), eventProfile('viha')]);
    expect(fetcher.mock.calls.every(([url]) => !/intent|agent|discover|proposals/.test(String(url)))).toBe(true);
  });
  it('rejects missing approval, duplicate keys and unrelated profile overwrites', async () => {
    const first = fixture(); await expect(createEventAccounts(first.value, { expectedReviewDigest: '0'.repeat(64), save: vi.fn(), fetcher: first.fetcher })).rejects.toMatchObject({ code: 'EXACT_EVENT_ACCOUNT_REVIEW_REQUIRED' }); expect(first.fetcher).not.toHaveBeenCalled();
    const second = fixture(); second.value.wallets[1].ownerKey = second.value.wallets[0].ownerKey; expect(() => accountReview(second.value)).toThrow();
    const third = fixture(); third.accounts[0].profile.displayName = 'Existing different owner profile';
    await expect(createEventAccounts(third.value, { expectedReviewDigest: eventReviewDigest(accountReview(third.value)), save: vi.fn(), fetcher: third.fetcher })).rejects.toMatchObject({ code: 'REFUSE_TO_OVERWRITE_OTHER_EVENT_PROFILE' });
  });
});
