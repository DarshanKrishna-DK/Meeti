import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createWorldProvider, WorldError, worldConfigFromEnv, type WorldBinding, type WorldConfig } from './index';

// Signed fixtures stay in this test file and are never used by application routes.
const issuer = 'https://auth.world.org';
const config: WorldConfig = { issuer, clientId: 'test-client', clientSecret: 'fixture-secret', clientAuthMethod: 'client_secret_basic' };
const baseline = 'https://world.org/oidc/acr/orb';
const face = baseline + '-face';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
const initialTime = Date.parse('2026-11-06T10:00:00.000Z');
const binding: WorldBinding = {
  challengeId: 'challenge-fixture', userId: 'user-fixture', sessionBinding: 'opaque-cookie-binding',
  proposalId: 'proposal-fixture', proposalDigest: 'immutable-proposal-digest', candidateId: 'other-user',
  action: 'introduce', nonce: 'nonce-fixture-'.repeat(4), issuedAt: initialTime, expiresAt: initialTime + 300000,
};
const metadata = {
  issuer, token_endpoint: issuer + '/api/v1/token', device_authorization_endpoint: issuer + '/api/v1/device_authorization',
  jwks_uri: issuer + '/.well-known/jwks.json', grant_types_supported: ['urn:ietf:params:oauth:grant-type:device_code'],
  scopes_supported: ['openid'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  id_token_signing_alg_values_supported: ['RS256'], acr_values_supported: [baseline, face], claims_parameter_supported: true,
};
const deviceResponse = { device_code: 'private-device-code-fixture', user_code: 'TEST-CODE', verification_uri: issuer + '/device',
  verification_uri_complete: issuer + '/device?user_code=TEST-CODE', expires_in: 1200, interval: 5 };

function token(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const claims = { iss: issuer, sub: 'caseSensitiveSubject', aud: config.clientId, exp: initialTime / 1000 + 300,
    iat: initialTime / 1000 + 5, auth_time: initialTime / 1000 + 5, jti: 'fixture-token-id', acr: baseline, amr: ['pop'], ...overrides };
  const input = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'JWT', ...header })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
}

function harness(options: { config?: WorldConfig; metadata?: unknown; device?: unknown; response?: { status: number; data: unknown }; jwks?: unknown } = {}) {
  let now = initialTime;
  let response = options.response || { status: 200, data: { id_token: token(), token_type: 'Bearer', access_token: 'fixture-access-token', expires_in: 300 } };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('openid-configuration')) return Response.json(options.metadata || metadata);
    if (path.endsWith('device_authorization')) return Response.json(options.device || deviceResponse);
    if (path.endsWith('jwks.json')) return Response.json(options.jwks || { keys: [jwk] });
    if (path.endsWith('/token')) return Response.json(response.data, { status: response.status });
    throw new Error(`Unexpected fixture URL: ${path}; method: ${init?.method}`);
  });
  const provider = createWorldProvider(options.config || config, { fetch: fetcher as typeof fetch, now: () => now });
  return { provider, fetcher, tick: (ms: number) => { now += ms; }, setResponse: (next: typeof response) => { response = next; } };
}

async function ready(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  const start = await h.provider.start(binding);
  h.tick(5000);
  return { ...h, ...start };
}

describe('official World IdP device human checkpoint', () => {
  it('fails closed without registered credentials and rejects an arbitrary issuer', () => {
    expect(() => worldConfigFromEnv({})).toThrow(WorldError);
    expect(() => worldConfigFromEnv({ WORLD_ISSUER: 'https://attacker.invalid', WORLD_CLIENT_ID: 'x', WORLD_CLIENT_SECRET: 'x' })).toThrow(WorldError);
    expect(() => worldConfigFromEnv({ WORLD_CLIENT_ID: 'idkit-app', WORLD_CLIENT_SECRET: 'x', WORLD_CLIENT_AUTH_METHOD: 'none' })).toThrow(WorldError);
  });

  it('creates a private provider session and a public code without disclosing device code or credentials', async () => {
    const h = harness();
    const { session, challenge } = await h.provider.start(binding);
    expect(challenge).toEqual({ challengeId: binding.challengeId, userCode: 'TEST-CODE', verificationUrl: deviceResponse.verification_uri_complete,
      expiresAt: new Date(binding.expiresAt).toISOString(), pollIntervalSeconds: 5, identityMode: 'hackathon-test-identity' });
    expect(session.deviceCode).toBe(deviceResponse.device_code);
    expect(JSON.stringify(challenge)).not.toContain(deviceResponse.device_code);
    expect(JSON.stringify(challenge)).not.toContain(config.clientSecret);
    const request = h.fetcher.mock.calls[1][1];
    expect(request?.redirect).toBe('error');
    const form = request?.body as URLSearchParams;
    expect(form.get('scope')).toBe('openid');
    expect(JSON.parse(form.get('claims')!)).toEqual({ id_token: { acr: { essential: true, values: [baseline, face] } } });
    expect(form.has('nonce')).toBe(false);
    expect(form.has('client_secret')).toBe(false);
    expect((request?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('test-client:fixture-secret').toString('base64')}`);
  });

  it('form-encodes Basic credentials and supports the registered Post method separately', async () => {
    const basic = harness({ config: { ...config, clientId: 'client:id', clientSecret: 'space + /' } });
    await basic.provider.start(binding);
    const authorization = (basic.fetcher.mock.calls[1][1]?.headers as Record<string, string>).Authorization;
    expect(Buffer.from(authorization.slice(6), 'base64').toString()).toBe('client%3Aid:space+%2B+%2F');
    const post = harness({ config: { ...config, clientAuthMethod: 'client_secret_post' } });
    await post.provider.start(binding);
    const request = post.fetcher.mock.calls[1][1];
    expect((request?.body as URLSearchParams).get('client_secret')).toBe(config.clientSecret);
    expect((request?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('honors the polling interval without an early token request', async () => {
    const h = harness(), { session } = await h.provider.start(binding);
    expect(await h.provider.poll(session, binding)).toMatchObject({ status: 'pending', pollIntervalSeconds: 5 });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps pending and slow-down results unauthorized without extending expiry', async () => {
    const h = await ready({ response: { status: 400, data: { error: 'authorization_pending' } } });
    const pending = await h.provider.poll(h.session, binding);
    expect(pending.status).toBe('pending');
    if (pending.status !== 'pending') throw new Error('Expected pending fixture response.');
    expect(pending.session.expiresAt).toBe(binding.expiresAt);
    h.tick(5000); h.setResponse({ status: 400, data: { error: 'slow_down' } });
    expect(await h.provider.poll(pending.session, binding)).toMatchObject({ status: 'pending', pollIntervalSeconds: 10, session: { expiresAt: binding.expiresAt } });
  });

  it('validates signed authentication and returns only minimal backend claims', async () => {
    const h = await ready(), result = await h.provider.poll(h.session, binding);
    expect(result).toMatchObject({ status: 'verified', verification: { issuer, subject: 'caseSensitiveSubject', tokenId: 'fixture-token-id',
      acr: baseline, amr: ['pop'], identityMode: 'hackathon-test-identity', expiresAt: new Date(binding.expiresAt).toISOString() } });
    expect(JSON.stringify(result)).not.toContain('id_token');
    expect(JSON.stringify(result)).not.toContain('fixture-access-token');
    if (result.status === 'verified') expect(result.verification.tokenDigest).toBe(createHash('sha256').update(token()).digest('hex'));
  });

  it.each([
    ['denied', { error: 'access_denied' }], ['expired', { error: 'expired_token' }], ['replay', { error: 'invalid_grant' }],
    ['unavailable', { error: 'invalid_client', error_description: 'secret provider data' }],
  ])('rejects provider %s and never copies raw error data', async (code, data) => {
    const h = await ready({ response: { status: 400, data } });
    await expect(h.provider.poll(h.session, binding)).rejects.toMatchObject({ code });
    await expect(h.provider.poll(h.session, binding)).rejects.not.toThrow('secret provider data');
  });

  it.each([429, 503])('rejects unavailable HTTP %s without approval', async status => {
    const h = await ready({ response: { status, data: { success: true } } });
    await expect(h.provider.poll(h.session, binding)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it.each(['userId', 'sessionBinding', 'proposalId', 'proposalDigest', 'candidateId', 'nonce', 'challengeId'] as const)('rejects changed %s before contacting World', async field => {
    const h = await ready();
    await expect(h.provider.poll(h.session, { ...binding, [field]: binding[field] + '-changed' })).rejects.toMatchObject({ code: 'binding' });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects expired, cancelled, or consumed local challenges before contacting World', async () => {
    const h = await ready();
    await expect(h.provider.poll({ ...h.session, status: 'cancelled' }, binding)).rejects.toMatchObject({ code: 'cancelled' });
    await expect(h.provider.poll({ ...h.session, status: 'consumed' }, binding)).rejects.toMatchObject({ code: 'replay' });
    h.tick(295000);
    await expect(h.provider.poll(h.session, binding)).rejects.toMatchObject({ code: 'expired' });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects expiry longer than five minutes, future issue times and invalid action bindings', async () => {
    const h = harness();
    for (const invalid of [{ ...binding, expiresAt: binding.expiresAt + 1 }, { ...binding, issuedAt: initialTime + 10000 },
      { ...binding, action: 'message' } as unknown as WorldBinding]) {
      await expect(h.provider.start(invalid)).rejects.toMatchObject({ code: 'binding' });
    }
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { iss: 'https://attacker.invalid' }, { aud: 'other-client' }, { azp: 'other-client' }, { aud: [config.clientId, 'other-client'] },
    { exp: initialTime / 1000 + 4 }, { iat: initialTime / 1000 + 60 }, { auth_time: initialTime / 1000 - 60 },
    { auth_time: initialTime / 1000 + 60 }, { nbf: initialTime / 1000 + 60 }, { acr: 'unverified' },
    { amr: [] }, { amr: ['pop', 'face'] }, { amr: ['pop', 'pop'] }, { acr: face, amr: ['pop'] },
    { nonce: 'not-valid-for-device-profile' }, { jti: '' }, { sub: '' },
  ])('rejects invalid signed claims %j', async overrides => {
    const h = await ready({ response: { status: 200, data: { id_token: token(overrides), token_type: 'Bearer', access_token: 'fixture', expires_in: 300 } } });
    await expect(h.provider.poll(h.session, binding)).rejects.toMatchObject({ code: 'invalid' });
  });

  it.each([{ amr: ['pop', 'user', 'mfa'] }, { amr: ['pop', 'face', 'user'] }])('accepts the documented method combination $amr', async ({ amr }) => {
    const h = await ready({ response: { status: 200, data: { id_token: token({ amr, acr: amr.includes('face') ? face : baseline }), token_type: 'Bearer', access_token: 'fixture', expires_in: 300 } } });
    expect(await h.provider.poll(h.session, binding)).toMatchObject({ status: 'verified' });
  });

  it('rejects forged client success and a token with an invalid signature', async () => {
    const h = await ready({ response: { status: 200, data: { verified: true, success: true } } });
    await expect(h.provider.poll(h.session, binding)).rejects.toMatchObject({ code: 'invalid' });
    const pieces = token().split('.'); pieces[1] = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url');
    h.setResponse({ status: 200, data: { id_token: pieces.join('.'), token_type: 'Bearer', access_token: 'fixture', expires_in: 300 } });
    await expect(h.provider.poll(h.session, binding)).rejects.toMatchObject({ code: 'invalid' });
  });

  it.each([{ alg: 'none' }, { alg: 'HS256' }, { kid: 'unknown-key' }, { jku: 'https://attacker.invalid/jwks' }, { crit: ['extension'] }])('rejects unsupported JWT header %j', async header => {
    const h = await ready({ response: { status: 200, data: { id_token: token({}, header), token_type: 'Bearer', access_token: 'fixture', expires_in: 300 } } });
    await expect(h.provider.poll(h.session, binding)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects duplicate JWKS key identifiers and signing keys with private material', async () => {
    for (const keyset of [{ keys: [jwk, jwk] }, { keys: [{ ...jwk, d: 'private-key-material' }] }, { keys: [{ ...jwk, key_ops: [] }] }]) {
      const h = await ready({ jwks: keyset });
      await expect(h.provider.poll(h.session, binding)).rejects.toMatchObject({ code: 'invalid' });
    }
  });

  it('rejects issuer and discovery endpoint substitution before sending credentials', async () => {
    for (const substitute of [{ ...metadata, issuer: 'https://attacker.invalid' }, { ...metadata, token_endpoint: 'https://attacker.invalid/token' },
      { ...metadata, jwks_uri: issuer + '@attacker.invalid/keys' }]) {
      const h = harness({ metadata: substitute });
      await expect(h.provider.start(binding)).rejects.toBeInstanceOf(WorldError);
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects a provider-supplied verification link outside the configured issuer', async () => {
    const h = harness({ device: { ...deviceResponse, verification_uri_complete: 'https://attacker.invalid/verify' } });
    await expect(h.provider.start(binding)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('keeps sandbox account mappings and test identity labels distinct', async () => {
    const sandbox = 'https://sandbox.auth.world.org';
    const h = harness({ config: { ...config, issuer: sandbox }, metadata: { ...metadata, issuer: sandbox,
      token_endpoint: sandbox + '/api/v1/token', device_authorization_endpoint: sandbox + '/api/v1/device_authorization', jwks_uri: sandbox + '/.well-known/jwks.json' },
    device: { ...deviceResponse, verification_uri: sandbox + '/device', verification_uri_complete: sandbox + '/device?user_code=TEST-CODE' },
    response: { status: 200, data: { id_token: token({ iss: sandbox }), token_type: 'Bearer', access_token: 'fixture', expires_in: 300 } } });
    const { session, challenge } = await h.provider.start(binding); h.tick(5000);
    expect(challenge.identityMode).toBe('sandbox-test-identity');
    expect(await h.provider.poll(session, binding)).toMatchObject({ status: 'verified', verification: { issuer: sandbox, identityMode: 'sandbox-test-identity' } });
  });

  it('rejects session substitution across issuers, clients, or provider deadlines', async () => {
    const h = await ready();
    for (const substitute of [{ ...h.session, issuer: WORLD_TEST_ISSUER }, { ...h.session, clientId: 'another-client' }]) {
      await expect(h.provider.poll(substitute, binding)).rejects.toMatchObject({ code: 'binding' });
    }
    await expect(h.provider.poll({ ...h.session, expiresAt: binding.expiresAt + 1 }, binding)).rejects.toMatchObject({ code: 'expired' });
  });

  it('does not authorize a challenge that expires while signing keys are fetched', async () => {
    let now = initialTime;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('openid-configuration')) return Response.json(metadata);
      if (String(url).endsWith('device_authorization')) return Response.json(deviceResponse);
      if (String(url).endsWith('jwks.json')) { now = binding.expiresAt; return Response.json({ keys: [jwk] }); }
      return Response.json({ id_token: token(), token_type: 'Bearer', access_token: 'fixture', expires_in: 300 });
    });
    const provider = createWorldProvider(config, { fetch: fetcher as typeof fetch, now: () => now });
    const { session } = await provider.start(binding); now += 5000;
    await expect(provider.poll(session, binding)).rejects.toBeInstanceOf(WorldError);
  });

  it('bounds repeated unknown-key refreshes to one per minute', async () => {
    const h = await ready();
    expect(await h.provider.poll(h.session, binding)).toMatchObject({ status: 'verified' });
    h.setResponse({ status: 200, data: { id_token: token({}, { kid: 'unknown-key' }), token_type: 'Bearer', access_token: 'fixture', expires_in: 300 } });
    for (let index = 0; index < 3; index += 1) await expect(h.provider.poll(h.session, binding)).rejects.toMatchObject({ code: 'invalid' });
    expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith('jwks.json'))).toHaveLength(1);
    h.tick(60000);
    await expect(h.provider.poll(h.session, binding)).rejects.toMatchObject({ code: 'invalid' });
    expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith('jwks.json'))).toHaveLength(2);
  });
});

const WORLD_TEST_ISSUER = 'https://sandbox.auth.world.org';

