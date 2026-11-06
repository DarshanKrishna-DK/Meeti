import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { decrypt, encrypt } from '../packages/server/crypto';
import type { AppState } from '../packages/shared/src';
import type { IntentSemantics } from '../packages/matching/src/semantics';
import { publicIntent } from '../packages/server/policy';
import { intentSigningMessage } from '../packages/arkiv/src';

// Only explicit fictional test accounts are created. No email or contact request is sent.
const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:3173';
const path = '.local-data/live-matching-accounts.enc';
const owners = { writer: '0x9253705482a44e6A7378163e57cc791AE6213ed5', metamask: '0xEE291Bc0246441F53610FbCAF2bC892110e72732' } as const;
type Role = keyof typeof owners;
type Account = { email: string; password: string; cookie: string; userId: string; challengeId?: string };
type Store = { writer?: Account; metamask?: Account; intents?: { role: Role; id: string; label: string }[] };
const store: Store = existsSync(path) ? decrypt(readFileSync(path, 'utf8'), 'live-matching-accounts') : {};
function save() { mkdirSync('.local-data', { recursive: true }); writeFileSync(path, encrypt(store, 'live-matching-accounts'), { mode: 0o600 }); }
async function api<T>(role: Role | null, endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(origin + '/api/' + endpoint, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(role && store[role]?.cookie ? { cookie: store[role]!.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${endpoint}: ${result.error?.code || response.status}: ${result.error?.message || 'Operation unavailable.'}`);
  if (role && response.headers.get('set-cookie')) store[role]!.cookie = response.headers.get('set-cookie')!.split(';')[0];
  return result.data as T;
}
async function setupUsers() {
  for (const role of ['writer', 'metamask'] as const) {
    if (!store[role]) {
      store[role] = { email: `meeti-${role}-${randomUUID().slice(0, 8)}@example.test`, password: randomBytes(32).toString('hex'), cookie: '', userId: '' }; save();
      const result = await api<{ id: string }>(role, 'auth/register', { email: store[role]!.email, password: store[role]!.password });
      store[role]!.userId = result.id; save();
    } else {
      await api(role, 'auth/login', { email: store[role]!.email, password: store[role]!.password }); save();
    }
    const current = await api<AppState>(role, 'state');
    await api(role, 'profile', { ...current.profile, displayName: `Fictional ${role} test participant`, headline: 'Fictional TEST DATA for Meeti networking validation.',
      bio: '', offering: '', seeking: '', tags: [], contact: '', employer: '', publicFields: ['displayName', 'headline'], aiConsent: true });
    if (!current.user.wallet) {
      const challenge = await api<{ id: string; message: string }>(role, 'wallet/challenge', { address: owners[role] });
      if (role === 'writer') {
        const account = privateKeyToAccount(process.env.ARKIV_PRIVATE_KEY as `0x${string}`);
        if (account.address.toLowerCase() !== owners.writer.toLowerCase()) throw new Error('The configured test signer does not match the approved writer.');
        await api(role, 'wallet/verify', { id: challenge.id, signature: await account.signMessage({ message: challenge.message }) });
      } else {
        store.metamask!.challengeId = challenge.id; save();
        writeFileSync('.local-data/live-matching-wallet-challenge.json', JSON.stringify({ chainId: 11155111, address: owners.metamask, ...challenge }, null, 2));
      }
    }
  }
  save(); console.log('Two fictional test accounts created through the real HTTP API; writer ownership signed and verified. MetaMask ownership challenge saved locally if needed. No World identity or consent was created.');
}
async function verifyMeta() {
  const file = JSON.parse(readFileSync('.local-data/live-matching-wallet-signature.json', 'utf8')) as { signature: string };
  await api('metamask', 'wallet/verify', { id: store.metamask?.challengeId, signature: file.signature });
  console.log('MetaMask test-account ownership verified by the real wallet challenge endpoint.');
}
async function refreshMeta() {
  const challenge = await api<{ id: string; message: string }>('metamask', 'wallet/challenge', { address: owners.metamask });
  store.metamask!.challengeId = challenge.id; save();
  writeFileSync('.local-data/live-matching-wallet-challenge.json', JSON.stringify({ chainId: 11155111, address: owners.metamask, ...challenge }, null, 2));
  console.log('Fresh five-minute MetaMask ownership challenge saved. No chain transaction requested.');
}
async function configureAgents() {
  const savedPolicy = JSON.parse(readFileSync('.local-data/ens-network-policy.json', 'utf8'));
  const policy = { purpose: savedPolicy.purpose, allowedFields: savedPolicy.allowedFields, allowedActions: savedPolicy.allowedActions, expiresAt: savedPolicy.expiresAt, paused: savedPolicy.paused };
  const resolver = { writer: '0xBc686bC5080ECBabcc3Bef38aA985865462D0433', metamask: process.env.MEETI_META_RESOLVER };
  for (const role of ['writer', 'metamask'] as const) {
    const current = await api<AppState>(role, 'state');
    if (!current.agent) {
      if (!resolver[role]) throw new Error('Confirm the actual MetaMask agent resolver and configure MEETI_META_RESOLVER before continuing.');
      await api(role, 'agent', { ensName: role === 'writer' ? 'agent.meeti-demo.eth' : 'agent.crypteck.eth', delegate: owners[role === 'writer' ? 'metamask' : 'writer'],
        persona: 'Fictional test participant representative. No private information is authorized.', resolverAddress: resolver[role], policyUri: '', policy });
    }
    await api(role, 'agent/check', {});
  }
  console.log('Both actual ENSv2 namespaces verified through the application authority endpoint.');
}
const examples = [
  { role: 'writer' as const, label: 'seeker', text: 'Fictional TEST DATA. I am seeking a DevRel job helping developers adopt open-source tools.', direction: 'seeking-job' as const, quote: 'seeking a DevRel job', roleText: 'DevRel', topics: ['open-source tools'], tags: ['devrel', 'open-source'] },
  { role: 'metamask' as const, label: 'recruiter', text: 'Fictional TEST DATA. We are hiring a developer advocate to help builders use open-source infrastructure.', direction: 'hiring' as const, quote: 'hiring a developer advocate', roleText: 'developer advocate', topics: ['open-source infrastructure'], tags: ['developer-advocacy', 'developer-tools'] },
  { role: 'metamask' as const, label: 'incompatible-seeker', text: 'Fictional TEST DATA. I am seeking a developer relations job helping builders use open-source infrastructure.', direction: 'seeking-job' as const, quote: 'seeking a developer relations job', roleText: 'developer relations', topics: ['open-source infrastructure'], tags: ['developer-relations', 'infrastructure'] },
];
async function prepareDrafts() {
  store.intents ??= [];
  for (const example of examples) {
    if (store.intents.some(value => value.label === example.label)) continue;
    const semantics: IntentSemantics = { schemaVersion: 1, category: 'collaborator', categoryEvidence: example.quote, direction: example.direction, directionEvidence: example.quote,
      canonicalRole: { value: example.roleText, sourceQuote: example.roleText }, topics: example.topics.map(value => ({ value, sourceQuote: value })), offers: [], requirements: [], clarificationQuestions: [] };
    const result = await api<{ id: string }>(example.role, 'intent', { goal: 'collaborator', summary: example.text, tags: example.tags,
      expiresAt: new Date(Date.now() + 86400000).toISOString(), publicApproved: true, demoOrigin: true, semantics });
    store.intents.push({ role: example.role, id: result.id, label: example.label }); save();
  }
  const review = [];
  for (const value of store.intents) {
    const state = await api<AppState>(value.role, 'state');
    const saved = state.intents.find(item => item.id === value.id);
    if (!saved || !state.agent) throw new Error('The reviewed intent or draft agent is missing.');
    const intent = publicIntent(saved, state.agent);
    const projection = { intent, signingMessage: intentSigningMessage(intent), liveEnsAuthorizationRequiredBeforePublication: true };
    review.push({ ...value, owner: owners[value.role], ...projection });
  }
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/arkiv-matching-review.json', JSON.stringify({ chainId: 7794095, network: 'Rabdi testnet', schema: 'meeti.public_intent.v2',
    maximumTotalFeePerWalletWei: '10000000000000000', maximumTotalFeePerWalletTGLM: '0.01', review, approval: 'Required before chain signatures or publication.' }, null, 2));
  console.log('Prepared three explicit fictional public intent projections for bounded Rabdi approval. No chain transaction was signed or sent.');
}
const mode = process.argv[2];
try {
  if (mode === 'setup-users') await setupUsers();
  else if (mode === 'verify-meta') await verifyMeta();
  else if (mode === 'refresh-meta') await refreshMeta();
  else if (mode === 'configure-agents') await configureAgents();
  else if (mode === 'prepare-drafts') await prepareDrafts();
  else throw new Error('Choose setup-users, verify-meta, configure-agents, or prepare-drafts. Publication requires a separate approved executor.');
} catch (error) { console.error(error instanceof Error ? error.message : 'The live test operation failed.'); process.exitCode = 1; }
