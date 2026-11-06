import { createHash, createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { z } from 'zod';

export const WORLD_ISSUERS = ['https://auth.world.org', 'https://sandbox.auth.world.org'] as const;
export const WORLD_MAX_AGE_MS = 5 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 5000;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const ASSURANCE_CLASSES = [
  'https://world.org/oidc/acr/orb', 'https://world.org/oidc/acr/orb-face',
  'https://world.org/oidc/acr/selfie', 'https://world.org/oidc/acr/selfie-face',
] as const;
const text = z.string().min(1).max(2048);
const timestamp = z.number().int().nonnegative();
const bindingSchema = z.object({
  challengeId: text, userId: text, sessionBinding: text, proposalId: text,
  proposalDigest: text, candidateId: text, action: z.literal('introduce'),
  nonce: z.string().min(32).max(256), issuedAt: timestamp, expiresAt: timestamp,
}).strict();

export type WorldBinding = z.infer<typeof bindingSchema>;
export type WorldConfig = {
  issuer: typeof WORLD_ISSUERS[number]; clientId: string; clientSecret: string;
  clientAuthMethod: 'client_secret_basic' | 'client_secret_post';
};
export type WorldIdentityMode = 'hackathon-test-identity' | 'sandbox-test-identity';
export type WorldChallenge = {
  challengeId: string; userCode: string; verificationUrl: string; expiresAt: string;
  pollIntervalSeconds: number; identityMode: WorldIdentityMode;
};
export type WorldSession = {
  binding: WorldBinding; deviceCode: string; issuer: string; clientId: string;
  acceptedAcr: string[]; intervalSeconds: number; nextPollAt: number; expiresAt: number;
  status: 'pending' | 'cancelled' | 'consumed';
};
export type WorldVerification = {
  issuer: string; subject: string; tokenId: string; tokenDigest: string;
  authTime: string; verifiedAt: string; expiresAt: string; acr: string; amr: string[];
  identityMode: WorldIdentityMode;
};
export type WorldPollResult =
  | { status: 'pending'; session: WorldSession; pollIntervalSeconds: number }
  | { status: 'verified'; verification: WorldVerification };
export type WorldErrorCode = 'configuration' | 'unavailable' | 'invalid' | 'denied' | 'expired' | 'binding' | 'replay' | 'cancelled';
export class WorldError extends Error {
  constructor(public readonly code: WorldErrorCode, message: string) { super(message); this.name = 'WorldError'; }
}
type Fetch = typeof globalThis.fetch;
type Dependencies = { fetch?: Fetch; now?: () => number };
const configSchema = z.object({
  issuer: z.enum(WORLD_ISSUERS), clientId: text, clientSecret: z.string().min(1).max(4096),
  clientAuthMethod: z.enum(['client_secret_basic', 'client_secret_post']),
}).strict();
const discoverySchema = z.object({
  issuer: z.string(), token_endpoint: z.string().url(), device_authorization_endpoint: z.string().url(), jwks_uri: z.string().url(),
  grant_types_supported: z.array(z.string()), scopes_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()), id_token_signing_alg_values_supported: z.array(z.string()),
  acr_values_supported: z.array(z.string()), claims_parameter_supported: z.boolean(),
});
type Discovery = z.infer<typeof discoverySchema>;
const jwkSchema = z.object({
  kty: z.literal('RSA'), kid: z.string().min(1).max(256), n: z.string().regex(/^[A-Za-z0-9_-]+$/).max(1400),
  e: z.string().regex(/^[A-Za-z0-9_-]+$/).max(16), alg: z.literal('RS256').optional(),
  use: z.literal('sig').optional(), key_ops: z.array(z.literal('verify')).min(1).max(1).optional(),
}).passthrough();
type SigningKey = z.infer<typeof jwkSchema>;
const claimsSchema = z.object({
  iss: text, sub: text, aud: z.union([text, z.array(text).min(1).max(10)]), azp: text.optional(),
  exp: timestamp, iat: timestamp, auth_time: timestamp, jti: text,
  acr: z.enum(ASSURANCE_CLASSES), amr: z.array(z.string().min(1).max(32)).min(1).max(6),
  nbf: timestamp.optional(), nonce: z.never().optional(),
});

export function worldConfigFromEnv(env: Record<string, string | undefined> = process.env): WorldConfig {
  const result = configSchema.safeParse({
    issuer: env.WORLD_ISSUER || WORLD_ISSUERS[0], clientId: env.WORLD_CLIENT_ID,
    clientSecret: env.WORLD_CLIENT_SECRET, clientAuthMethod: env.WORLD_CLIENT_AUTH_METHOD || 'client_secret_basic',
  });
  if (!result.success) throw new WorldError('configuration', 'Configure the registered World IdP issuer, client ID, secret, and authentication method. Protected introductions remain locked.');
  return result.data;
}

/** This adapter authenticates a human checkpoint. Application consent and authority remain separate gates. */
export class WorldAgentPassProvider {
  private readonly config: WorldConfig;
  private readonly fetcher: Fetch;
  private readonly now: () => number;
  private discoveryCache?: { value: Discovery; until: number };
  private keysCache?: { value: SigningKey[]; fetchedAt: number };

  constructor(config: WorldConfig, dependencies: Dependencies = {}) {
    const result = configSchema.safeParse(config);
    if (!result.success) throw new WorldError('configuration', 'World IdP configuration is invalid.');
    this.config = result.data;
    this.fetcher = dependencies.fetch || globalThis.fetch;
    this.now = dependencies.now || Date.now;
  }

  private identityMode(): WorldIdentityMode {
    return this.config.issuer === WORLD_ISSUERS[1] ? 'sandbox-test-identity' : 'hackathon-test-identity';
  }

  private officialUrl(value: string): string {
    const url = new URL(value);
    if (url.origin !== this.config.issuer || url.username || url.password || url.hash) throw new WorldError('invalid', 'World returned an unexpected endpoint.');
    return value;
  }

  private async request(url: string, init: RequestInit = {}, expiresAt = this.now() + 10000): Promise<{ status: number; data: unknown }> {
    const remaining = Math.min(10000, expiresAt - this.now());
    if (remaining <= 0) throw new WorldError('expired', 'This World checkpoint expired. Start a new checkpoint.');
    try {
      const response = await this.fetcher(this.officialUrl(url), {
        ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(remaining),
      });
      if (response.status >= 500 || response.status === 429) throw new WorldError('unavailable', 'World authentication is unavailable. No protected action has been authorized.');
      const content = await response.text();
      if (content.length > 65536) throw new WorldError('invalid', 'World returned an invalid response.');
      return { status: response.status, data: JSON.parse(content) as unknown };
    } catch (error) {
      if (error instanceof WorldError) throw error;
      throw new WorldError('unavailable', 'World authentication could not be checked. No protected action has been authorized.');
    }
  }

  private async discovery(): Promise<Discovery> {
    if (this.discoveryCache && this.discoveryCache.until > this.now()) return this.discoveryCache.value;
    const response = await this.request(`${this.config.issuer}/.well-known/openid-configuration`);
    const result = discoverySchema.safeParse(response.data);
    if (response.status !== 200 || !result.success) throw new WorldError('invalid', 'World discovery metadata is invalid.');
    const value = result.data;
    for (const url of [value.device_authorization_endpoint, value.token_endpoint, value.jwks_uri]) this.officialUrl(url);
    if (value.issuer !== this.config.issuer || !value.grant_types_supported.includes(DEVICE_GRANT)
      || !value.scopes_supported.includes('openid') || !value.id_token_signing_alg_values_supported.includes('RS256')
      || !value.token_endpoint_auth_methods_supported.includes(this.config.clientAuthMethod) || !value.claims_parameter_supported) {
      throw new WorldError('configuration', 'The configured World issuer does not support the required authentication profile.');
    }
    this.discoveryCache = { value, until: this.now() + WORLD_MAX_AGE_MS };
    return value;
  }

  private form(fields: Record<string, string>): RequestInit {
    const body = new URLSearchParams(fields);
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const encode = (value: string) => new URLSearchParams({ value }).toString().slice(6);
    if (this.config.clientAuthMethod === 'client_secret_basic') {
      headers.Authorization = `Basic ${Buffer.from(`${encode(this.config.clientId)}:${encode(this.config.clientSecret)}`).toString('base64')}`;
    } else {
      body.set('client_id', this.config.clientId); body.set('client_secret', this.config.clientSecret);
    }
    return { method: 'POST', headers, body };
  }

  private validateBinding(value: WorldBinding): WorldBinding {
    const result = bindingSchema.safeParse(value);
    if (!result.success || result.data.expiresAt <= result.data.issuedAt || result.data.expiresAt - result.data.issuedAt > WORLD_MAX_AGE_MS
      || result.data.issuedAt > this.now() + CLOCK_TOLERANCE_MS) throw new WorldError('binding', 'The World checkpoint binding is invalid.');
    if (result.data.expiresAt <= this.now()) throw new WorldError('expired', 'This World checkpoint expired. Start a new checkpoint.');
    return result.data;
  }

  async start(binding: WorldBinding): Promise<{ session: WorldSession; challenge: WorldChallenge }> {
    const saved = this.validateBinding(binding);
    const metadata = await this.discovery();
    const acceptedAcr = ASSURANCE_CLASSES.filter(x => metadata.acr_values_supported.includes(x));
    if (!acceptedAcr.length) throw new WorldError('configuration', 'World does not advertise an accepted human verification class.');
    const response = await this.request(metadata.device_authorization_endpoint, this.form({
      scope: 'openid', claims: JSON.stringify({ id_token: { acr: { essential: true, values: acceptedAcr } } }),
    }), saved.expiresAt);
    const result = z.object({ device_code: text, user_code: z.string().min(1).max(128), verification_uri: z.string().url(),
      verification_uri_complete: z.string().url().optional(), expires_in: z.number().int().positive().max(86400),
      interval: z.number().int().positive().max(300).default(5),
    }).safeParse(response.data);
    if (response.status !== 200 || !result.success) throw new WorldError('unavailable', 'World could not start the checkpoint. No action has been authorized.');
    const value = result.data;
    this.officialUrl(value.verification_uri);
    const verificationUrl = this.officialUrl(value.verification_uri_complete || value.verification_uri);
    const expiresAt = Math.min(saved.expiresAt, this.now() + value.expires_in * 1000);
    this.validateBinding(saved);
    return {
      session: { binding: saved, deviceCode: value.device_code, issuer: this.config.issuer, clientId: this.config.clientId,
        acceptedAcr, intervalSeconds: value.interval, nextPollAt: this.now() + value.interval * 1000, expiresAt, status: 'pending' },
      challenge: { challengeId: saved.challengeId, userCode: value.user_code, verificationUrl,
        expiresAt: new Date(expiresAt).toISOString(), pollIntervalSeconds: value.interval, identityMode: this.identityMode() },
    };
  }

  async poll(session: WorldSession, binding: WorldBinding): Promise<WorldPollResult> {
    const saved = this.validateBinding(binding);
    if (JSON.stringify(bindingSchema.parse(session.binding)) !== JSON.stringify(saved) || session.issuer !== this.config.issuer || session.clientId !== this.config.clientId) {
      throw new WorldError('binding', 'This World checkpoint belongs to a different session or introduction.');
    }
    if (session.status === 'cancelled') throw new WorldError('cancelled', 'This World checkpoint was cancelled.');
    if (session.status !== 'pending') throw new WorldError('replay', 'This World checkpoint has already been consumed.');
    if (!Number.isSafeInteger(session.expiresAt) || session.expiresAt > saved.expiresAt || session.expiresAt <= this.now()) throw new WorldError('expired', 'This World checkpoint expired.');
    if (!Number.isSafeInteger(session.intervalSeconds) || session.intervalSeconds < 1 || session.intervalSeconds > 600
      || !Number.isSafeInteger(session.nextPollAt) || !session.acceptedAcr.length || session.acceptedAcr.some(x => !(ASSURANCE_CLASSES as readonly string[]).includes(x))) {
      throw new WorldError('invalid', 'This World checkpoint has invalid polling requirements.');
    }
    if (this.now() < session.nextPollAt) return { status: 'pending', session, pollIntervalSeconds: Math.ceil((session.nextPollAt - this.now()) / 1000) };
    const metadata = await this.discovery();
    const response = await this.request(metadata.token_endpoint, this.form({ grant_type: DEVICE_GRANT, device_code: session.deviceCode }), session.expiresAt);
    const error = z.object({ error: z.string() }).safeParse(response.data);
    if (response.status === 400 && error.success && ['authorization_pending', 'slow_down'].includes(error.data.error)) {
      const intervalSeconds = Math.min(600, session.intervalSeconds + (error.data.error === 'slow_down' ? 5 : 0));
      return { status: 'pending', session: { ...session, intervalSeconds, nextPollAt: this.now() + intervalSeconds * 1000 }, pollIntervalSeconds: intervalSeconds };
    }
    if (error.success) {
      const code = error.data.error;
      if (code === 'access_denied') throw new WorldError('denied', 'World authentication was denied. The introduction remains locked.');
      if (code === 'expired_token') throw new WorldError('expired', 'This World checkpoint expired.');
      if (code === 'invalid_grant') throw new WorldError('replay', 'This World checkpoint is invalid or has already been consumed.');
      throw new WorldError('unavailable', 'World could not verify this checkpoint. The introduction remains locked.');
    }
    const result = z.object({ id_token: z.string().min(1).max(16384), token_type: z.literal('Bearer'), access_token: text, expires_in: z.number().int().positive() }).safeParse(response.data);
    if (response.status !== 200 || !result.success) throw new WorldError('invalid', 'World did not return a valid authentication result.');
    const verification = await this.validateToken(result.data.id_token, session, metadata);
    this.validateBinding(saved);
    if (session.expiresAt <= this.now()) throw new WorldError('expired', 'This World checkpoint expired during verification.');
    return { status: 'verified', verification };
  }

  private async signingKey(kid: string, metadata: Discovery): Promise<SigningKey> {
    let key = this.keysCache?.value.find(x => x.kid === kid);
    const age = this.keysCache ? this.now() - this.keysCache.fetchedAt : Infinity;
    if (age >= WORLD_MAX_AGE_MS || (!key && age >= 60000)) {
      const response = await this.request(metadata.jwks_uri);
      const result = z.object({ keys: z.array(z.unknown()).min(1).max(20) }).safeParse(response.data);
      if (response.status !== 200 || !result.success) throw new WorldError('invalid', 'World signing keys are invalid.');
      const keys = result.data.keys.flatMap(value => { const parsed = jwkSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
      if (new Set(keys.map(x => x.kid)).size !== keys.length) throw new WorldError('invalid', 'World returned ambiguous signing keys.');
      this.keysCache = { value: keys, fetchedAt: this.now() };
      key = keys.find(x => x.kid === kid);
    }
    if (!key) throw new WorldError('invalid', 'The World authentication signing key is unknown.');
    return key;
  }

  private async validateToken(token: string, session: WorldSession, metadata: Discovery): Promise<WorldVerification> {
    try {
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some(x => !/^[A-Za-z0-9_-]+$/.test(x) || Buffer.from(x, 'base64url').toString('base64url') !== x)) throw new Error();
      const header = z.object({ alg: z.literal('RS256'), kid: z.string().min(1).max(256), typ: z.literal('JWT').optional() }).strict().parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
      const jwk = await this.signingKey(header.kid, metadata);
      if (['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some(x => x in jwk)) throw new Error();
      const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
      const bits = key.asymmetricKeyDetails?.modulusLength;
      if (key.asymmetricKeyType !== 'rsa' || !bits || bits < 2048 || bits > 8192
        || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw new Error();
      const claims = claimsSchema.parse(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
      const now = this.now(), authTime = claims.auth_time * 1000, issuedAt = claims.iat * 1000, tokenExpiry = claims.exp * 1000;
      const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
      if (claims.iss !== this.config.issuer || !audiences.includes(this.config.clientId) || new Set(audiences).size !== audiences.length
        || (audiences.length > 1 && claims.azp !== this.config.clientId) || (claims.azp !== undefined && claims.azp !== this.config.clientId)
        || tokenExpiry <= now || tokenExpiry <= issuedAt || issuedAt > now + CLOCK_TOLERANCE_MS
        || issuedAt < authTime - CLOCK_TOLERANCE_MS || (claims.nbf !== undefined && claims.nbf * 1000 > now + CLOCK_TOLERANCE_MS)
        || authTime < session.binding.issuedAt - CLOCK_TOLERANCE_MS || authTime > now + CLOCK_TOLERANCE_MS
        || now - authTime > WORLD_MAX_AGE_MS || !session.acceptedAcr.includes(claims.acr)) throw new Error();
      const methods = [...claims.amr].sort().join(',');
      if (claims.acr.endsWith('-face') ? methods !== 'face,pop,user' : !['pop', 'mfa,pop,user'].includes(methods)) throw new Error();
      const expiresAt = Math.min(session.expiresAt, tokenExpiry, authTime + WORLD_MAX_AGE_MS);
      if (expiresAt <= now) throw new Error();
      return { issuer: claims.iss, subject: claims.sub, tokenId: claims.jti, tokenDigest: createHash('sha256').update(token).digest('hex'),
        authTime: new Date(authTime).toISOString(), verifiedAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
        acr: claims.acr, amr: claims.amr, identityMode: this.identityMode() };
    } catch (error) {
      if (error instanceof WorldError) throw error;
      throw new WorldError('invalid', 'World authentication validation failed. No protected action has been authorized.');
    }
  }
}

export function createWorldProvider(config = worldConfigFromEnv(), dependencies?: Dependencies): WorldAgentPassProvider {
  return new WorldAgentPassProvider(config, dependencies);
}
