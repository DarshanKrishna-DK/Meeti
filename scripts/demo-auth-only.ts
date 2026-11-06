import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import { z } from 'zod';

export type DemoLabel = 'demo-seeker' | 'demo-recruiter';
const labels: DemoLabel[] = ['demo-seeker', 'demo-recruiter'];
const statement = 'Sign in to Meeti. This signature does not authorize transactions or public disclosure.';
export class DemoAuthError extends Error { constructor(readonly code: string) { super(code); } }
export type DemoAuthBinding = { sessions: Record<DemoLabel, string>; accounts: Record<DemoLabel, string>; wallets: Record<DemoLabel, string>; authenticatedAt: string };

/** Hosted destinations require an explicit operator target matching the configured application origin. */
export function demoTarget(environment: { APP_ORIGIN?: string; DEMO_AUTH_TARGET_ORIGIN?: string }) {
  let url: URL;
  try { url = new URL(environment.APP_ORIGIN || 'http://127.0.0.1:3173'); } catch { throw new DemoAuthError('INVALID_DEMO_ORIGIN'); }
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !local && (url.protocol !== 'https:' || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[|.*\.(local|localhost)$)/i.test(url.hostname))) throw new DemoAuthError('INVALID_DEMO_ORIGIN');
  const explicit = Boolean(environment.DEMO_AUTH_TARGET_ORIGIN);
  if (explicit) {
    let target: URL;
    try { target = new URL(environment.DEMO_AUTH_TARGET_ORIGIN!); } catch { throw new DemoAuthError('EXPLICIT_DEMO_TARGET_MISMATCH'); }
    if (target.origin !== url.origin || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new DemoAuthError('EXPLICIT_DEMO_TARGET_MISMATCH');
  }
  if (!local && !explicit) throw new DemoAuthError('HOSTED_DEMO_REQUIRES_EXPLICIT_TARGET');
  return { origin: url.origin, local, explicit };
}
function responseCookie(response: Response, name: 'meeti_wallet_flow' | 'meeti_session') {
  const values = response.headers.getSetCookie().filter(value => value.startsWith(name + '='));
  if (values.length !== 1 || !new RegExp(`^${name}=[a-f0-9]{64};`).test(values[0])) throw new DemoAuthError('AUTH_COOKIE_INVALID');
  return values[0].split(';')[0];
}
export function assertDemoChallenge(origin: string, address: string, input: unknown) {
  const challenge = z.object({ id: z.string().uuid(), message: z.string().max(4096), chainId: z.literal(11155111), address: z.string(), expiresAt: z.string().optional() }).strict().parse(input);
  const parsed = parseSiweMessage(challenge.message), now = Date.now();
  if (!parsed.issuedAt || !parsed.expirationTime || parsed.issuedAt.getTime() > now + 30000 || now - parsed.issuedAt.getTime() > 300000
    || parsed.expirationTime.getTime() <= now || parsed.expirationTime.getTime() - parsed.issuedAt.getTime() !== 300000
    || !/^[a-f0-9]{64}$/.test(parsed.nonce || '') || parsed.domain !== new URL(origin).host || parsed.uri !== origin || parsed.chainId !== 11155111
    || parsed.address?.toLowerCase() !== address.toLowerCase() || challenge.address.toLowerCase() !== address.toLowerCase() || parsed.requestId !== challenge.id) throw new DemoAuthError('UNEXPECTED_AUTH_CHALLENGE');
  const expected = createSiweMessage({ address: address as `0x${string}`, chainId: 11155111, domain: new URL(origin).host, uri: origin, version: '1',
    nonce: parsed.nonce!, issuedAt: parsed.issuedAt, expirationTime: parsed.expirationTime, requestId: challenge.id, statement });
  if (challenge.message !== expected || challenge.expiresAt && Date.parse(challenge.expiresAt) !== parsed.expirationTime.getTime()) throw new DemoAuthError('UNEXPECTED_AUTH_CHALLENGE');
  return challenge;
}

/** Only sign-in paths and state read-back are reachable. No model, setup, publication or transaction API is accepted. */
export async function reauthenticateDemoAccounts(options: {
  origin: string; expectedAccounts: Partial<Record<DemoLabel, string>>;
  wallets: { label: string; privateKey: `0x${string}` }[];
  preflight: (label: DemoLabel, expectedId: string, address: string) => Promise<void>;
  fetcher?: typeof fetch;
}): Promise<DemoAuthBinding> {
  const target = demoTarget({ APP_ORIGIN: options.origin, DEMO_AUTH_TARGET_ORIGIN: options.origin });
  const accounts = z.object({ 'demo-seeker': z.string().uuid(), 'demo-recruiter': z.string().uuid() }).strict().parse(options.expectedAccounts);
  if (accounts['demo-seeker'] === accounts['demo-recruiter'] || options.wallets.length !== 2 || new Set(options.wallets.map(value => value.label)).size !== 2) throw new DemoAuthError('TWO_EXISTING_DISTINCT_ACCOUNTS_REQUIRED');
  const signers = labels.map(label => {
    const wallet = options.wallets.find(value => value.label === label);
    if (!wallet || !/^0x[a-f0-9]{64}$/i.test(wallet.privateKey)) throw new DemoAuthError('DEMO_WALLET_INVALID');
    return { label, signer: privateKeyToAccount(wallet.privateKey) };
  });
  if (new Set(signers.map(value => value.signer.address.toLowerCase())).size !== 2) throw new DemoAuthError('TWO_DISTINCT_WALLETS_REQUIRED');
  // Verify both migrated IDs before making the first authentication request or signature.
  for (const { label, signer } of signers) await options.preflight(label, accounts[label], signer.address);
  const fetcher = options.fetcher || fetch;
  async function request(path: 'health' | 'auth/wallet/challenge' | 'auth/wallet/verify' | 'state', cookie?: string, body?: unknown) {
    const response = await fetcher(`${target.origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
      headers: { origin: target.origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new DemoAuthError(`AUTH_HTTP_${response.status}`);
    return { data: (await response.json()).data, response };
  }
  const health = await request('health');
  if (health.data?.storage !== 'postgres' || health.data?.integrations?.world?.status !== 'deferred') throw new DemoAuthError('POSTGRES_AND_PAUSED_WORLD_REQUIRED');
  const sessions = {} as Record<DemoLabel, string>, wallets = {} as Record<DemoLabel, string>;
  for (const { label, signer } of signers) {
    const result = await request('auth/wallet/challenge', undefined, { address: signer.address, chainId: 11155111 });
    const challenge = assertDemoChallenge(target.origin, signer.address, result.data), flow = responseCookie(result.response, 'meeti_wallet_flow');
    const signature = await signer.signMessage({ message: challenge.message });
    const verified = await request('auth/wallet/verify', flow, { id: challenge.id, signature });
    if (verified.data?.id !== accounts[label] || verified.data?.wallet?.toLowerCase() !== signer.address.toLowerCase()) throw new DemoAuthError('RECOVERED_ACCOUNT_CHANGED');
    const session = responseCookie(verified.response, 'meeti_session'), state = await request('state', session);
    if (state.data?.user?.id !== accounts[label] || state.data?.user?.wallet?.toLowerCase() !== signer.address.toLowerCase()) throw new DemoAuthError('AUTHENTICATED_ACCOUNT_READBACK_MISMATCH');
    sessions[label] = session; wallets[label] = signer.address;
  }
  return { sessions, accounts, wallets, authenticatedAt: new Date().toISOString() };
}
