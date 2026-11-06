import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSiweMessage } from 'viem/siwe';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { route } from '../packages/server/router';
import { closeDatabase, db, profile, saveAgent, saveIntent } from '../packages/server/db';
import { encrypt, hash } from '../packages/server/crypto';
import type { Agent } from '../packages/shared/src';

const origin = 'http://127.0.0.1:3198';
let directory: string;
async function call(path: string, body?: unknown, cookie?: string, overrideOrigin = origin) {
  return route(new Request(`${origin}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: overrideOrigin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split('/'));
}
function cookie(response: Response, name: string): string {
  return response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))!.split(';')[0];
}
async function challenge(account = privateKeyToAccount(generatePrivateKey()), chainId = 1) {
  const response = await call('auth/wallet/challenge', { address: account.address, chainId });
  expect(response.status).toBe(200);
  const { data } = await response.json() as { data: { id: string; message: string; address: string; chainId: number; expiresAt: string } };
  const signature = await account.signMessage({ message: data.message });
  return { account, response, data, signature, flow: cookie(response, 'meeti_wallet_flow') };
}
async function signIn(account = privateKeyToAccount(generatePrivateKey())) {
  const prepared = await challenge(account);
  const response = await call('auth/wallet/verify', { id: prepared.data.id, signature: prepared.signature }, prepared.flow);
  expect(response.status).toBe(200);
  const { data } = await response.json() as { data: { id: string; wallet: string; chainId: number } };
  return { ...prepared, response, data, session: cookie(response, 'meeti_session') };
}

beforeEach(() => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), 'meeti-wallet-auth-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite'));
  vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  vi.stubEnv('APP_ORIGIN', origin);
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('wallet sign-in with real generated EOA signatures', () => {
  it('issues fresh EIP-4361 messages bound to domain, URI, owner, chain and five-minute expiry', async () => {
    const first = await challenge(undefined, 11155111), second = await challenge(first.account, 8453);
    const parsed = parseSiweMessage(first.data.message);
    expect(parsed).toMatchObject({ address: first.account.address, chainId: 11155111, domain: '127.0.0.1:3198', uri: origin, version: '1', requestId: first.data.id });
    expect(parsed.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.nonce).not.toBe(parseSiweMessage(second.data.message).nonce);
    expect(Date.parse(first.data.expiresAt) - parsed.issuedAt!.getTime()).toBe(300000);
    expect(first.response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict; Max-Age=300');
    const row = db().prepare('SELECT flow_hash FROM wallet_auth_challenges WHERE id=?').get(first.data.id) as { flow_hash: string };
    expect(row.flow_hash).toBe(hash(first.flow.split('=')[1]));
    expect(second.data.chainId).toBe(8453);
  });

  it('creates a durable private account and opaque session without invented profile data or authority', async () => {
    const owner = await signIn();
    expect(owner.data.wallet.toLowerCase()).toBe(owner.account.address.toLowerCase());
    expect(owner.response.headers.getSetCookie().find(value => value.startsWith('meeti_session='))).toContain('HttpOnly; SameSite=Strict');
    expect(owner.response.headers.getSetCookie().find(value => value.startsWith('meeti_wallet_flow='))).toContain('Max-Age=0');
    expect(profile(owner.data.id)).toEqual({ displayName: '', headline: '', bio: '', seeking: '', offering: '', tags: [], contact: '', employer: '', publicFields: [], aiConsent: false });
    expect(db().prepare('SELECT token_hash FROM sessions WHERE user_id=?').get(owner.data.id)).toEqual({ token_hash: hash(owner.session.split('=')[1]) });
    expect(db().prepare('SELECT id FROM agents WHERE user_id=?').get(owner.data.id)).toBeUndefined();
    expect(db().prepare('SELECT id FROM intents WHERE user_id=?').get(owner.data.id)).toBeUndefined();
    closeDatabase();
    const state = await call('state', undefined, owner.session);
    expect(state.status).toBe(200);
    expect((await state.json()).data.user.wallet).toBe(owner.account.address.toLowerCase());
  });

  it('reuses the same wallet account and preserves its saved private profile', async () => {
    const first = await signIn();
    const value = { ...profile(first.data.id), displayName: 'Owner supplied name', employer: 'Owner supplied private employer' };
    db().prepare('UPDATE users SET profile=? WHERE id=?').run(encrypt(value, `profile:${first.data.id}`), first.data.id);
    const second = await signIn(first.account);
    expect(second.data.id).toBe(first.data.id);
    expect(profile(second.data.id)).toEqual(value);
    expect((db().prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count).toBe(1);
    expect(second.session).not.toBe(first.session);
  });

  it('signs into the existing email account already bound to the wallet', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const registered = await call('auth/register', { email: 'existing@example.test', password: 'an existing long test password' });
    expect(registered.status).toBe(200);
    const { data } = await registered.json();
    db().prepare('UPDATE users SET wallet=? WHERE id=?').run(account.address, data.id);
    const signed = await signIn(account);
    expect(signed.data.id).toBe(data.id);
    expect((db().prepare('SELECT email FROM users WHERE id=?').get(data.id) as { email: string }).email).toBe('existing@example.test');
  });

  it('rejects a valid signature from another wallet and altered message signatures', async () => {
    const prepared = await challenge();
    const other = privateKeyToAccount(generatePrivateKey());
    const wrong = await call('auth/wallet/verify', { id: prepared.data.id, signature: await other.signMessage({ message: prepared.data.message }) }, prepared.flow);
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error.code).toBe('INVALID_SIGNATURE');
    const changed = await call('auth/wallet/verify', { id: prepared.data.id, signature: await prepared.account.signMessage({ message: `${prepared.data.message} altered` }) }, prepared.flow);
    expect(changed.status).toBe(403);
    expect((db().prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count).toBe(0);
  });

  it('rejects missing, mismatched and duplicated browser flow cookies', async () => {
    const prepared = await challenge(), other = await challenge();
    for (const flow of [undefined, other.flow, `${prepared.flow}; ${prepared.flow}`]) {
      const result = await call('auth/wallet/verify', { id: prepared.data.id, signature: prepared.signature }, flow);
      expect(result.status).toBe(403);
      expect((await result.json()).error.code).toBe('SIGN_IN_FLOW_MISMATCH');
    }
  });

  it('rejects expired challenges and replay after success', async () => {
    const expired = await challenge();
    db().prepare('UPDATE wallet_auth_challenges SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), expired.data.id);
    expect((await call('auth/wallet/verify', { id: expired.data.id, signature: expired.signature }, expired.flow)).status).toBe(403);
    const current = await challenge();
    expect((await call('auth/wallet/verify', { id: current.data.id, signature: current.signature }, current.flow)).status).toBe(200);
    expect((await call('auth/wallet/verify', { id: current.data.id, signature: current.signature }, current.flow)).status).toBe(403);
  });

  it('allows only one concurrent completion of the same signed challenge', async () => {
    const prepared = await challenge();
    const results = await Promise.all([1, 2].map(() => call('auth/wallet/verify', { id: prepared.data.id, signature: prepared.signature }, prepared.flow)));
    expect(results.map(result => result.status).sort()).toEqual([200, 403]);
    expect((db().prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }).count).toBe(1);
  });

  it('rejects cross-origin requests, invalid inputs and malformed signatures', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    expect((await call('auth/wallet/challenge', { address: account.address, chainId: 1 }, undefined, 'https://elsewhere.example')).status).toBe(403);
    for (const body of [{ address: 'invalid', chainId: 1 }, { address: account.address, chainId: 0 }, { address: account.address, chainId: 1.5 }, { address: account.address, chainId: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect((await call('auth/wallet/challenge', body)).status).toBe(400);
    }
    const prepared = await challenge(account);
    expect((await call('auth/wallet/verify', { id: prepared.data.id, signature: '0x00' }, prepared.flow)).status).toBe(400);
    const invalid = await call('auth/wallet/verify', { id: prepared.data.id, signature: `0x${'00'.repeat(65)}` }, prepared.flow);
    expect(invalid.status).toBe(403);
    expect((await invalid.json()).error.code).toBe('INVALID_SIGNATURE');
  });
});

describe('persisted owner-scoped onboarding', () => {
  it('requires a session and keeps tour preferences separate for two wallets across restart', async () => {
    expect((await call('onboarding')).status).toBe(401);
    const left = await signIn(), right = await signIn();
    const initial = { profileComplete: false, tourCompleted: false, hasAgent: false, hasIntent: false, hasPublishedIntent: false };
    expect((await (await call('onboarding', undefined, left.session)).json()).data).toEqual(initial);
    expect((await call('onboarding', { tourCompleted: true }, left.session)).status).toBe(200);
    closeDatabase();
    expect((await (await call('onboarding', undefined, left.session)).json()).data).toEqual({ ...initial, tourCompleted: true });
    expect((await (await call('onboarding', undefined, right.session)).json()).data).toEqual(initial);
    expect((await call('onboarding', { tourCompleted: true, userId: left.data.id }, right.session)).status).toBe(400);
    expect((await call('onboarding', { tourCompleted: false }, left.session)).status).toBe(200);
    expect(profile(left.data.id).displayName).toBe('');
  });

  it('derives actual progress and excludes expired or revoked intentions', async () => {
    const owner = await signIn();
    const supplied = { ...profile(owner.data.id), displayName: 'Owner', seeking: 'A collaborator', offering: 'TypeScript' };
    db().prepare('UPDATE users SET profile=? WHERE id=?').run(encrypt(supplied, `profile:${owner.data.id}`), owner.data.id);
    const value: Agent = { id: randomUUID(), ensName: 'owner.fixture.eth', owner: owner.account.address, delegate: `0x${'22'.repeat(20)}`, persona: '', config: {}, authority: null,
      policy: { version: 1, purpose: 'collaborator', allowedFields: [], allowedActions: [], expiresAt: new Date(Date.now() + 600000).toISOString(), paused: true } };
    saveAgent(owner.data.id, value);
    const intent = { id: randomUUID(), version: 1, goal: 'collaborator' as const, summary: 'Owner supplied test intention', tags: ['typescript'], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), policyVersion: 1, status: 'draft' as const, demoOrigin: true };
    saveIntent(owner.data.id, intent);
    expect((await (await call('onboarding', undefined, owner.session)).json()).data).toMatchObject({ profileComplete: true, hasAgent: true, hasIntent: true, hasPublishedIntent: false });
    saveIntent(owner.data.id, { ...intent, status: 'published' });
    expect((await (await call('onboarding', undefined, owner.session)).json()).data.hasPublishedIntent).toBe(true);
    saveIntent(owner.data.id, { ...intent, status: 'published', expiresAt: new Date(Date.now() - 1).toISOString() });
    expect((await (await call('onboarding', undefined, owner.session)).json()).data).toMatchObject({ hasIntent: false, hasPublishedIntent: false });
    saveIntent(owner.data.id, { ...intent, status: 'revoked' });
    expect((await (await call('onboarding', undefined, owner.session)).json()).data.hasIntent).toBe(false);
    expect(profile(owner.data.id)).toEqual(supplied);
  });
});
