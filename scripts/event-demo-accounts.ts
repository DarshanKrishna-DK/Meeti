import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { decrypt, encrypt } from '../packages/server/crypto';
import type { AppState, Profile } from '../packages/shared/src';
import { assertDemoChallenge } from './demo-auth-only';

export const EVENT_ORIGIN = 'https://meeti-theta.vercel.app';
export const EVENT_VAULT_PATH = '.local-data/event-demo-v1.enc';
export const EVENT_VAULT_CONTEXT = 'meeti-event-demo-v1';
export const EVENT_REVIEW_PATH = 'artifacts/event-demo-accounts-review.json';
export const eventLabels = ['krishna', 'viha'] as const;
export type EventLabel = typeof eventLabels[number];
const secret = z.string().regex(/^0x[a-f0-9]{64}$/i).transform(value => value as `0x${string}`);
export const eventVaultSchema = z.object({ version: z.literal(1), origin: z.literal(EVENT_ORIGIN), createdAt: z.string().datetime(),
  wallets: z.array(z.object({ label: z.enum(eventLabels), ownerKey: secret, delegateKey: secret, accountId: z.string().uuid().optional(), session: z.string().optional(), profileConfirmedAt: z.string().datetime().optional() }).strict()).length(2),
}).strict();
export type EventVault = z.infer<typeof eventVaultSchema>;
export class EventDemoError extends Error { constructor(readonly code: string) { super(code); } }
export const eventProfile = (label: EventLabel): Profile => ({
  displayName: label === 'krishna' ? 'Krishna' : 'Viha',
  headline: label === 'krishna' ? 'Fictional event venue host' : 'Fictional event sponsor',
  bio: label === 'krishna' ? 'Fictional TEST DATA. Krishna offers venue hosting for events. No actual venue, location or capacity is claimed.' : 'Fictional TEST DATA. Viha offers event sponsorship. No actual organization, budget or committed funds are claimed.',
  offering: label === 'krishna' ? 'Venue hosting for events. Fictional test offer.' : 'Event sponsorship. Fictional test offer.',
  seeking: '', tags: label === 'krishna' ? ['events', 'venue-hosting'] : ['events', 'sponsorship'], contact: '', employer: '', publicFields: [], aiConsent: true,
  roles: [label === 'krishna' ? 'Event venue host' : 'Event sponsor'], skills: [], interests: [], goals: [], location: '', timezone: '', languages: [], availability: '',
  collaborationMode: 'unspecified', contextSharing: 'private-agent', socialLinks: [],
});
function vault(input: unknown) {
  const value = eventVaultSchema.parse(input);
  if (new Set(value.wallets.map(item => item.label)).size !== 2 || new Set(value.wallets.flatMap(item => [privateKeyToAccount(item.ownerKey).address.toLowerCase(), privateKeyToAccount(item.delegateKey).address.toLowerCase()])).size !== 4) throw new EventDemoError('FOUR_DISTINCT_EVENT_KEYS_REQUIRED');
  return value;
}
export function accountReview(input: EventVault) {
  const value = vault(input);
  return { version: 1, reviewOnly: true, fictional: true, humanVerified: false, origin: EVENT_ORIGIN, createdAt: value.createdAt,
    accounts: eventLabels.map(label => {
      const item = value.wallets.find(item => item.label === label)!;
      return { label, owner: privateKeyToAccount(item.ownerKey).address, delegate: privateKeyToAccount(item.delegateKey).address, proposedLabel: `event-${label}`, profile: eventProfile(label) };
    }),
    scope: 'Create or recover these two generated fictional wallet accounts through exact nonce-bound sign-in messages and save only the reviewed private profiles. Public profile fields remain empty. AI consent covers fictional context only; this helper makes no model call.',
    exclusions: ['No blockchain transaction signatures or broadcasts.', 'No ENS registration, funding, agent import, public intent signature or Arkiv publication.', 'No World verification, human credentials, actual venue capacity, sponsorship budget, location or availability claim.'],
  };
}
export const eventReviewDigest = (review: unknown) => createHash('sha256').update(JSON.stringify(review)).digest('hex');

export async function createEventAccounts(input: EventVault, options: { expectedReviewDigest: string; save: (value: EventVault) => void; fetcher?: typeof fetch }) {
  const value = vault(input);
  if (eventReviewDigest(accountReview(value)) !== options.expectedReviewDigest) throw new EventDemoError('EXACT_EVENT_ACCOUNT_REVIEW_REQUIRED');
  const fetcher = options.fetcher || fetch;
  async function api<T>(path: 'health' | 'auth/wallet/challenge' | 'auth/wallet/verify' | 'state' | 'profile', session?: string, body?: unknown) {
    const response = await fetcher(`${EVENT_ORIGIN}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
      headers: { origin: EVENT_ORIGIN, ...(session ? { cookie: session } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new EventDemoError(`EVENT_ACCOUNT_HTTP_${response.status}`);
    return { data: (await response.json()).data as T, response };
  }
  function cookie(response: Response, name: string) {
    const values = response.headers.getSetCookie().filter(value => value.startsWith(name + '='));
    if (values.length !== 1 || !new RegExp(`^${name}=[a-f0-9]{64};`).test(values[0])) throw new EventDemoError('EVENT_SESSION_COOKIE_INVALID');
    return values[0].split(';')[0];
  }
  const health = await api<{ storage: string; integrations: AppState['integrations'] }>('health');
  if (health.data.storage !== 'postgres' || health.data.integrations.world.status !== 'deferred') throw new EventDemoError('EVENT_POSTGRES_AND_PAUSED_WORLD_REQUIRED');
  for (const label of eventLabels) {
    const item = value.wallets.find(item => item.label === label)!, signer = privateKeyToAccount(item.ownerKey);
    const challenge = await api<unknown>('auth/wallet/challenge', undefined, { address: signer.address, chainId: 11155111 });
    const checked = assertDemoChallenge(EVENT_ORIGIN, signer.address, challenge.data);
    const flow = cookie(challenge.response, 'meeti_wallet_flow');
    // This exact statement expressly excludes transactions and public disclosure. No other message is signed.
    const signature = await signer.signMessage({ message: checked.message });
    const verified = await api<{ id: string; wallet: string }>('auth/wallet/verify', flow, { id: checked.id, signature });
    const id = z.string().uuid().parse(verified.data.id);
    if (verified.data.wallet.toLowerCase() !== signer.address.toLowerCase() || item.accountId && item.accountId !== id) throw new EventDemoError('EVENT_ACCOUNT_BINDING_CHANGED');
    item.accountId = id; item.session = cookie(verified.response, 'meeti_session'); options.save(value);
    const state = (await api<AppState>('state', item.session)).data;
    if (state.user.id !== id || state.user.wallet?.toLowerCase() !== signer.address.toLowerCase() || state.agent || state.intents.length || state.rooms.length || state.proposals.length) throw new EventDemoError('EVENT_ACCOUNT_IS_NOT_FRESH_OR_REVIEWED');
    const profile = eventProfile(label), existing = state.profile;
    const blank = !existing.displayName && !existing.bio && !existing.headline && !existing.offering && !existing.seeking && !existing.contact && !existing.employer && !existing.tags.length && !existing.publicFields.length && !existing.aiConsent;
    if (!blank && Object.entries(profile).some(([key, expected]) => JSON.stringify(existing[key as keyof Profile]) !== JSON.stringify(expected))) throw new EventDemoError('REFUSE_TO_OVERWRITE_OTHER_EVENT_PROFILE');
    if (blank) await api('profile', item.session, profile);
    const readback = (await api<AppState>('state', item.session)).data;
    if (readback.user.id !== id || readback.user.wallet?.toLowerCase() !== signer.address.toLowerCase() || Object.entries(profile).some(([key, expected]) => JSON.stringify(readback.profile[key as keyof Profile]) !== JSON.stringify(expected))) throw new EventDemoError('EVENT_PRIVATE_PROFILE_READBACK_FAILED');
    item.profileConfirmedAt = new Date().toISOString(); options.save(value);
  }
  if (value.wallets[0].accountId === value.wallets[1].accountId) throw new EventDemoError('TWO_DISTINCT_EVENT_ACCOUNTS_REQUIRED');
  return { origin: EVENT_ORIGIN, fictional: true, humanVerified: false, accounts: value.wallets.map(item => ({ label: item.label, displayName: eventProfile(item.label).displayName, accountId: item.accountId, owner: privateKeyToAccount(item.ownerKey).address, privateProfileConfirmedAt: item.profileConfirmedAt })), modelCalls: 0, publicIntentSignatures: 0, chainTransactions: 0 };
}

function saveVault(value: EventVault) {
  const temporary = `${EVENT_VAULT_PATH}.tmp`; writeFileSync(temporary, encrypt(value, EVENT_VAULT_CONTEXT), { mode: 0o600 }); renameSync(temporary, EVENT_VAULT_PATH);
}
async function main() {
  const mode = process.argv[2];
  if (!['prepare', 'create'].includes(mode)) throw new EventDemoError('CHOOSE_EVENT_PREPARE_OR_CREATE');
  mkdirSync('.local-data', { recursive: true }); mkdirSync('artifacts', { recursive: true });
  if (!existsSync(EVENT_VAULT_PATH)) {
    if (mode !== 'prepare') throw new EventDemoError('EVENT_REVIEW_MUST_BE_PREPARED_FIRST');
    const value: EventVault = { version: 1, origin: EVENT_ORIGIN, createdAt: new Date().toISOString(), wallets: eventLabels.map(label => ({ label, ownerKey: generatePrivateKey(), delegateKey: generatePrivateKey() })) };
    writeFileSync(EVENT_VAULT_PATH, encrypt(value, EVENT_VAULT_CONTEXT), { flag: 'wx', mode: 0o600 });
  }
  const metadata = lstatSync(EVENT_VAULT_PATH); if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32768) throw new EventDemoError('EVENT_VAULT_SCOPE_INVALID');
  const value = vault(decrypt<unknown>(readFileSync(EVENT_VAULT_PATH, 'utf8'), EVENT_VAULT_CONTEXT)), review = accountReview(value), digest = eventReviewDigest(review);
  if (mode === 'prepare') {
    writeFileSync(EVENT_REVIEW_PATH, JSON.stringify({ ...review, digest }, null, 2));
    console.log(JSON.stringify({ review: EVENT_REVIEW_PATH, digest, origin: EVENT_ORIGIN, accounts: review.accounts.map(({ label, owner, delegate }) => ({ label, owner, delegate })), modelCalls: 0, signatures: 0, chainTransactions: 0 }));
  } else {
    const expected = process.argv.find(value => value.startsWith('--expected-review-digest='))?.split('=')[1];
    if (!expected || expected !== digest || process.argv.length !== 4) throw new EventDemoError('EXACT_EVENT_ACCOUNT_REVIEW_REQUIRED');
    console.log(JSON.stringify(await createEventAccounts(value, { expectedReviewDigest: expected, save: saveVault })));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main().catch(error => { console.error(JSON.stringify({ code: error instanceof EventDemoError ? error.code : 'EVENT_ACCOUNT_STOPPED_NO_PRIVATE_DIAGNOSTICS' })); process.exitCode = 1; });
