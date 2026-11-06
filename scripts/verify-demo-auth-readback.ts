import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import type { Hex } from 'viem';
import { decrypt } from '../packages/server/crypto';

// Explicit local authentication signatures only. This verifier never signs transactions,
// changes profiles, creates wallets, writes application SQL, or persists session credentials.
type Label = 'demo-seeker' | 'demo-recruiter';
type Saved = { version: 1; origin: string; accounts: Record<Label, string>; sessions: Record<Label, string> };
type Vault = { version: 1; wallets: { label: string; privateKey: Hex }[] };
type Challenge = { id: string; message: string; address: string; chainId: number; expiresAt: string };
type UserState = { user: { id: string; wallet: string | null } };
type Envelope<T> = { data?: T; error?: { code?: string } };
type Check = { label: Label; existingAccountConfirmed: boolean; wrongBrowserDenied: boolean; missingFlowDenied: boolean;
  mismatchedSignerDenied: boolean; consumedChallengeReplayDenied: boolean; recoveredSameAccount: boolean;
  newSessionsOwnAccountOnly: boolean; savedSessionPreserved: boolean };
class AuthReadbackError extends Error { constructor(readonly code: string) { super(code); } }
function requireCheck(value: unknown, code: string): asserts value { if (!value) throw new AuthReadbackError(code); }
const labels: Label[] = ['demo-seeker', 'demo-recruiter'];
const allowedPaths = new Set(['auth/wallet/challenge', 'auth/wallet/verify', 'auth/logout', 'state']);
const temporarySessions: string[] = [], checks: Check[] = [];
let saved: Saved | undefined, origin = '', signatures = 0, logoutSucceeded = 0, failure: string | null = null;

async function call<T>(path: string, cookie?: string, body?: unknown) {
  requireCheck(allowedPaths.has(path) && (path === 'state') === (body === undefined), 'LOCAL_ENDPOINT_SCOPE_VIOLATION');
  let response: Response;
  try {
    response = await fetch(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new AuthReadbackError('LOCAL_HTTP_REQUEST_UNAVAILABLE'); }
  let value: Envelope<T>;
  try { value = await response.json() as Envelope<T>; } catch { throw new AuthReadbackError('LOCAL_HTTP_RESPONSE_INVALID'); }
  return { response, value };
}
function cookie(response: Response, name: 'meeti_wallet_flow' | 'meeti_session') {
  const headers = response.headers.getSetCookie().filter(header => header.startsWith(`${name}=`));
  requireCheck(headers.length === 1 && /;\s*HttpOnly(?:;|$)/i.test(headers[0]) && /;\s*SameSite=Strict(?:;|$)/i.test(headers[0]), 'OPAQUE_SECURE_COOKIE_REQUIRED');
  const value = headers[0].split(';')[0]; requireCheck(new RegExp(`^${name}=[a-f0-9]{64}$`).test(value), 'OPAQUE_COOKIE_FORMAT_INVALID'); return value;
}
async function ownState(session: string, label: Label, address: string) {
  const result = await call<UserState>('state', session);
  requireCheck(result.response.status === 200 && result.value.data?.user.id === saved!.accounts[label]
    && result.value.data.user.id !== saved!.accounts[labels.find(value => value !== label)!]
    && result.value.data.user.wallet?.toLowerCase() === address.toLowerCase(), 'AUTHENTICATED_ACCOUNT_ISOLATION_FAILED');
}
async function challenge(address: string) {
  const result = await call<Challenge>('auth/wallet/challenge', undefined, { address, chainId: 11155111 });
  requireCheck(result.response.status === 200 && result.value.data, 'CHALLENGE_REQUEST_FAILED');
  const value = result.value.data, parsed = parseSiweMessage(value.message), now = Date.now();
  requireCheck(/^[a-f0-9-]{36}$/.test(value.id) && value.address.toLowerCase() === address.toLowerCase() && value.chainId === 11155111
    && parsed.address?.toLowerCase() === address.toLowerCase() && parsed.domain === new URL(origin).host && parsed.uri === origin
    && parsed.chainId === 11155111 && parsed.version === '1' && parsed.requestId === value.id && /^[a-f0-9]{64}$/.test(parsed.nonce || '')
    && parsed.issuedAt instanceof Date && parsed.expirationTime instanceof Date && Number.isFinite(parsed.issuedAt.getTime())
    && parsed.expirationTime.getTime() === Date.parse(value.expiresAt) && parsed.expirationTime.getTime() - parsed.issuedAt.getTime() === 300000
    && parsed.issuedAt.getTime() <= now + 10000 && parsed.issuedAt.getTime() >= now - 30000 && parsed.expirationTime.getTime() > now
    && parsed.statement === 'Sign in to Meeti. This signature does not authorize transactions or public disclosure.', 'UNEXPECTED_SIGN_IN_CHALLENGE');
  return { value, flow: cookie(result.response, 'meeti_wallet_flow') };
}
async function sign(account: ReturnType<typeof privateKeyToAccount>, value: Challenge) { signatures++; return account.signMessage({ message: value.message }); }
async function denied(value: Awaited<ReturnType<typeof challenge>>, signature: Hex, flow: string | undefined, code: string) {
  const result = await call('auth/wallet/verify', flow, { id: value.value.id, signature });
  requireCheck(result.response.status === 403 && result.value.error?.code === code
    && !result.response.headers.getSetCookie().some(header => header.startsWith('meeti_session=')), 'AUTHENTICATION_DENIAL_CHECK_FAILED');
}
async function verify(value: Awaited<ReturnType<typeof challenge>>, signature: Hex, label: Label, address: string) {
  const result = await call<{ id: string; wallet: string; chainId: number }>('auth/wallet/verify', value.flow, { id: value.value.id, signature });
  requireCheck(result.response.status === 200, 'SIGN_IN_VERIFICATION_FAILED');
  const session = cookie(result.response, 'meeti_session');
  requireCheck(!Object.values(saved!.sessions).includes(session) && !temporarySessions.includes(session), 'NEW_SESSION_MUST_BE_DISTINCT');
  // Register for cleanup before any subsequent assertion can fail.
  temporarySessions.push(session);
  requireCheck(result.value.data?.id === saved!.accounts[label] && result.value.data.wallet.toLowerCase() === address.toLowerCase()
    && result.value.data.chainId === 11155111, 'IDEMPOTENT_ACCOUNT_RECOVERY_FAILED');
  await ownState(session, label, address); return session;
}

try {
  requireCheck(process.argv.slice(2).length === 1 && process.argv[2] === '--execute-local-test', 'EXPLICIT_EXECUTE_LOCAL_TEST_REQUIRED');
  origin = new URL(process.env.APP_ORIGIN || 'http://127.0.0.1:3173').origin;
  const url = new URL(origin);
  requireCheck(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '3173' && !url.username && !url.password, 'EXACT_LOCAL_DEMO_ORIGIN_REQUIRED');
  saved = decrypt<Saved>(readFileSync('.local-data/demo-core-flow.enc', 'utf8'), 'meeti-demo-core-flow-v1');
  requireCheck(saved.version === 1 && saved.origin === origin && saved.accounts['demo-seeker'] !== saved.accounts['demo-recruiter'], 'TWO_SAVED_DEMO_ACCOUNTS_REQUIRED');
  for (const label of labels) requireCheck(/^[a-f0-9-]{36}$/.test(saved.accounts[label]) && /^meeti_session=[a-f0-9]{64}$/.test(saved.sessions[label]), 'EXISTING_DEMO_ACCOUNT_SESSION_REQUIRED');
  const vault = decrypt<Vault>(readFileSync('.local-data/demo-wallets.enc', 'utf8'), 'meeti-demo-wallets-v1');
  requireCheck(vault.version === 1 && vault.wallets.length === 2 && labels.every(label => vault.wallets.filter(wallet => wallet.label === label).length === 1), 'TWO_EXISTING_FICTIONAL_OWNER_KEYS_REQUIRED');
  const owners = labels.map(label => ({ label, account: privateKeyToAccount(vault.wallets.find(wallet => wallet.label === label)!.privateKey) }));
  requireCheck(owners[0].account.address !== owners[1].account.address, 'DISTINCT_DEMO_OWNERS_REQUIRED');
  // Verify both saved identities before permitting any authentication signature or account-recovery request.
  for (const owner of owners) await ownState(saved.sessions[owner.label], owner.label, owner.account.address);
  const prepared = [];
  for (const owner of owners) prepared.push(await challenge(owner.account.address));
  for (let index = 0; index < owners.length; index++) {
    const owner = owners[index], current = prepared[index];
    const check: Check = { label: owner.label, existingAccountConfirmed: true, wrongBrowserDenied: false, missingFlowDenied: false, mismatchedSignerDenied: false,
      consumedChallengeReplayDenied: false, recoveredSameAccount: false, newSessionsOwnAccountOnly: false, savedSessionPreserved: false }; checks.push(check);
    const signature = await sign(owner.account, current.value);
    await denied(current, signature, undefined, 'SIGN_IN_FLOW_MISMATCH'); check.missingFlowDenied = true;
    await denied(current, signature, prepared[1 - index].flow, 'SIGN_IN_FLOW_MISMATCH'); check.wrongBrowserDenied = true;
    const wrongSignature = await sign(owners[1 - index].account, current.value);
    await denied(current, wrongSignature, current.flow, 'INVALID_SIGNATURE'); check.mismatchedSignerDenied = true;
    await verify(current, signature, owner.label, owner.account.address); check.newSessionsOwnAccountOnly = true;
    await denied(current, signature, current.flow, 'CHALLENGE_EXPIRED'); check.consumedChallengeReplayDenied = true;
    const again = await challenge(owner.account.address);
    await verify(again, await sign(owner.account, again.value), owner.label, owner.account.address); check.recoveredSameAccount = true;
  }
} catch (error) { failure = error instanceof AuthReadbackError ? error.code : 'LOCAL_AUTH_READBACK_FAILED'; }
finally {
  for (const session of temporarySessions) {
    try {
      const response = await call('auth/logout', session, {}); requireCheck(response.response.status === 200, 'TEMPORARY_SESSION_LOGOUT_FAILED');
      const after = await call('state', session); requireCheck(after.response.status === 401, 'TEMPORARY_SESSION_NOT_REVOKED'); logoutSucceeded++;
    } catch { failure ??= 'TEMPORARY_SESSION_CLEANUP_FAILED'; }
  }
  // Saved sessions are read only, including after temporary-session cleanup.
  if (saved && checks.length && origin) {
    for (const check of checks) {
      try {
        const state = await call<UserState>('state', saved.sessions[check.label]);
        requireCheck(state.response.status === 200 && state.value.data?.user.id === saved.accounts[check.label], 'SAVED_SESSION_NOT_PRESERVED'); check.savedSessionPreserved = true;
      } catch { failure ??= 'SAVED_SESSION_READBACK_FAILED'; }
    }
  }
}
console.log(JSON.stringify({ passed: failure === null, failure, scope: 'Actual local HTTP wallet authentication with existing fictional EOA owners. No transaction signatures, models or direct database writes.',
  checks, authenticationSignatures: signatures, temporarySessionsCreated: temporarySessions.length, temporarySessionsRevoked: logoutSucceeded,
  blockchainTransactions: 0, modelRequests: 0, independentHumanOrDeviceAcceptance: false }, null, 2));
if (failure) process.exitCode = 1;
