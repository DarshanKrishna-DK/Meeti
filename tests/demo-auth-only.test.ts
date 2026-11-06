import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { verifyMessage } from 'viem';
import { assertDemoChallenge, demoTarget, reauthenticateDemoAccounts, type DemoLabel } from '../scripts/demo-auth-only';

const origin = 'https://meeti-fixture.vercel.app';
const statement = 'Sign in to Meeti. This signature does not authorize transactions or public disclosure.';
function challenge(address: `0x${string}`, overrides: Record<string, unknown> = {}) {
  const id = randomUUID(), issuedAt = new Date(), expirationTime = new Date(issuedAt.getTime() + 300000);
  return { id, address, chainId: 11155111, expiresAt: expirationTime.toISOString(), message: createSiweMessage({ address, chainId: 11155111, domain: new URL(origin).host, uri: origin, version: '1', nonce: randomBytes(32).toString('hex'), issuedAt, expirationTime, requestId: id, statement }), ...overrides };
}
function fixture() {
  const wallets = (['demo-seeker', 'demo-recruiter'] as DemoLabel[]).map(label => ({ label, privateKey: generatePrivateKey() }));
  const expectedAccounts = { 'demo-seeker': randomUUID(), 'demo-recruiter': randomUUID() };
  const entries = wallets.map(wallet => ({ ...wallet, address: privateKeyToAccount(wallet.privateKey).address, id: expectedAccounts[wallet.label], flow: randomBytes(32).toString('hex'), session: randomBytes(32).toString('hex'), challenge: undefined as ReturnType<typeof challenge> | undefined }));
  const preflight = vi.fn(async () => {});
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    expect(url.origin).toBe(origin); expect(init?.redirect).toBe('error'); expect(headers.get('origin')).toBe(origin);
    if (url.pathname === '/api/health') return Response.json({ data: { storage: 'postgres', integrations: { world: { status: 'deferred' } } } });
    if (url.pathname === '/api/auth/wallet/challenge') {
      expect(headers.has('cookie')).toBe(false);
      const owner = entries.find(value => value.address === body.address)!; owner.challenge = challenge(owner.address);
      return Response.json({ data: owner.challenge }, { headers: { 'Set-Cookie': `meeti_wallet_flow=${owner.flow}; HttpOnly` } });
    }
    if (url.pathname === '/api/auth/wallet/verify') {
      const owner = entries.find(value => value.challenge?.id === body.id)!;
      expect(headers.get('cookie')).toBe(`meeti_wallet_flow=${owner.flow}`);
      expect(await verifyMessage({ address: owner.address, message: owner.challenge!.message, signature: body.signature })).toBe(true);
      return Response.json({ data: { id: owner.id, wallet: owner.address } }, { headers: { 'Set-Cookie': `meeti_session=${owner.session}; HttpOnly` } });
    }
    if (url.pathname === '/api/state') {
      const owner = entries.find(value => headers.get('cookie') === `meeti_session=${value.session}`)!;
      return Response.json({ data: { user: { id: owner.id, wallet: owner.address } } });
    }
    throw new Error('fixture_forbidden_auth_path');
  });
  return { wallets, expectedAccounts, entries, preflight, fetcher: fetcher as typeof fetch & typeof fetcher };
}
describe('explicit demo authentication with real local EOA signatures and fixture HTTP only', () => {
  it('requires exact explicit hosted origin and rejects credential or path forwarding', () => {
    expect(demoTarget({ APP_ORIGIN: origin, DEMO_AUTH_TARGET_ORIGIN: origin })).toMatchObject({ origin, explicit: true, local: false });
    expect(demoTarget({ APP_ORIGIN: 'http://127.0.0.1:3173' })).toMatchObject({ local: true });
    for (const environment of [{ APP_ORIGIN: origin }, { APP_ORIGIN: origin, DEMO_AUTH_TARGET_ORIGIN: 'https://other.vercel.app' }, { APP_ORIGIN: origin + '/private', DEMO_AUTH_TARGET_ORIGIN: origin }, { APP_ORIGIN: 'https://user:password@meeti.example', DEMO_AUTH_TARGET_ORIGIN: origin }, { APP_ORIGIN: 'https://127.0.0.1', DEMO_AUTH_TARGET_ORIGIN: 'https://127.0.0.1' }]) expect(() => demoTarget(environment)).toThrow();
  });
  it('recovers both exact existing accounts, uses separate flow cookies and calls only auth/read paths', async () => {
    const state = fixture(), result = await reauthenticateDemoAccounts({ origin, ...state });
    expect(result.accounts).toEqual(state.expectedAccounts); expect(state.preflight).toHaveBeenCalledTimes(2);
    expect(state.fetcher).toHaveBeenCalledTimes(7);
    expect(result.sessions['demo-seeker']).not.toBe(result.sessions['demo-recruiter']);
    expect(result.wallets['demo-seeker']).toBe(state.entries[0].address);
    for (const wallet of state.wallets) expect(JSON.stringify(result)).not.toContain(wallet.privateKey);
  });
  it('fails before any HTTP request when either migrated account preflight fails', async () => {
    const state = fixture(); state.preflight.mockRejectedValueOnce(new Error('fixture_missing_account'));
    await expect(reauthenticateDemoAccounts({ origin, ...state })).rejects.toThrow('fixture_missing_account');
    expect(state.fetcher).not.toHaveBeenCalled();
  });
  it('rejects a changed account response without returning sessions', async () => {
    const state = fixture(); state.expectedAccounts['demo-seeker'] = randomUUID();
    await expect(reauthenticateDemoAccounts({ origin, ...state })).rejects.toMatchObject({ code: 'RECOVERED_ACCOUNT_CHANGED' });
    expect(state.fetcher).toHaveBeenCalledTimes(3);
  });
  it('rejects noncanonical, expired, wrong-chain or changed-domain challenges before signing', () => {
    const address = privateKeyToAccount(generatePrivateKey()).address, valid = challenge(address);
    expect(assertDemoChallenge(origin, address, valid)).toEqual(valid);
    for (const input of [{ ...valid, chainId: 1 }, { ...valid, message: valid.message + '\nResources:\n- https://unapproved.example' }, { ...valid, message: valid.message.replace(new URL(origin).host, 'unapproved.example') }, { ...valid, message: valid.message.replace(statement, 'Authorize public disclosure.') }, { ...valid, expiresAt: new Date(0).toISOString() }]) expect(() => assertDemoChallenge(origin, address, input)).toThrow();
  });
  it('refuses duplicate wallet identities before preflight or requests', async () => {
    const state = fixture(); state.wallets[1].privateKey = state.wallets[0].privateKey;
    await expect(reauthenticateDemoAccounts({ origin, ...state })).rejects.toMatchObject({ code: 'TWO_DISTINCT_WALLETS_REQUIRED' });
    expect(state.preflight).not.toHaveBeenCalled(); expect(state.fetcher).not.toHaveBeenCalled();
  });
});
