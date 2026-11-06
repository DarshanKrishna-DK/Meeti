import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { route } from '../packages/server/router';
import { closeDatabase, db } from '../packages/server/db';
import type { AppState, ContextDocument, Intent } from '../packages/shared/src';

// Real loopback HTTP, EOA signatures, nonce verification, sessions and encrypted SQLite.
// There are no authority or model substitutions. External services are intentionally disabled.
let directory: string, origin: string, server: Server;
const networkRequests: string[] = [];
type Reply<T = unknown> = { response: Response; data: T; error?: { code: string; message: string } };
class FreshAccount {
  readonly signer = privateKeyToAccount(generatePrivateKey());
  cookie = '';
  async call<T = unknown>(path: string, body?: unknown): Promise<Reply<T>> {
    const response = await fetch(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    return { response, ...result };
  }
  async signIn() {
    const challenge = await this.call<{ id: string; message: string }>('auth/wallet/challenge', { address: this.signer.address, chainId: 11155111 });
    expect(challenge.response.status).toBe(200);
    this.cookie = challenge.response.headers.getSetCookie().find(value => value.startsWith('meeti_wallet_flow='))!.split(';')[0];
    const signature = await this.signer.signMessage({ message: challenge.data.message });
    const verified = await this.call<{ id: string }>('auth/wallet/verify', { id: challenge.data.id, signature });
    expect(verified.response.status).toBe(200);
    this.cookie = verified.response.headers.getSetCookie().find(value => value.startsWith('meeti_session='))!.split(';')[0];
    return { id: verified.data.id, challengeId: challenge.data.id, signature };
  }
  async state() { const result = await this.call<AppState>('state'); expect(result.response.status).toBe(200); return result.data; }
  async setup(name: string) {
    const initial = await this.state();
    const saved = await this.call('profile', { ...initial.profile, displayName: name, seeking: 'A developer education collaborator', offering: 'Technical documentation',
      roles: ['Developer advocate'], skills: ['Technical writing'], timezone: 'Asia/Kolkata', languages: ['English'],
      contact: `${name.toLowerCase()}@example.invalid`, publicFields: [], contextSharing: 'private-agent', aiConsent: true });
    expect(saved.response.status).toBe(200);
    const configured = await this.call('agent', { ensName: `networking.${name.toLowerCase()}.users.meeti-demo.eth`, delegate: privateKeyToAccount(generatePrivateKey()).address,
      persona: '', resolverAddress: '', policyUri: '', policy: { purpose: 'collaborator', allowedFields: ['documentContext'],
        allowedActions: ['discover', 'publish', 'evaluate', 'negotiate', 'introduce'], expiresAt: new Date(Date.now() + 86400000).toISOString(), paused: false } });
    expect(configured.response.status).toBe(200);
  }
}

beforeEach(async () => {
  closeDatabase(); directory = mkdtempSync(join(tmpdir(), 'meeti-fresh-http-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite')); vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  for (const key of ['ENS_SEPOLIA_RPC_URL', 'ENS_SEPOLIA_AUTH_RPC_URL', 'ARKIV_ACCESS_KEY', 'AI_API_KEY', 'AI_MODEL', 'EMBEDDING_API_KEY']) vi.stubEnv(key, '');
  vi.stubEnv('SUPABASE_STORAGE_ENABLED', 'false'); vi.stubEnv('WORLD_CAPABILITY_ENABLED', 'false');
  vi.stubEnv('ENS_PROJECT_PARENT', 'meeti-demo.eth'); vi.stubEnv('ENS_PROJECT_ISSUER', privateKeyToAccount(generatePrivateKey()).address);
  server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const request = new Request(`${origin}${incoming.url}`, { method: incoming.method, headers,
        ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const response = await route(request, new URL(request.url).pathname.slice('/api/'.length).split('/'));
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => { if (key !== 'set-cookie') outgoing.setHeader(key, value); });
      outgoing.setHeader('set-cookie', response.headers.getSetCookie());
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.statusCode = 500; outgoing.end(JSON.stringify({ error: { code: 'HTTP_DRIVER_FAILURE' } })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`; vi.stubEnv('APP_ORIGIN', origin);
  networkRequests.length = 0;
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    networkRequests.push(url);
    if (new URL(url).origin !== origin) throw new Error('External provider access is forbidden in this isolated flow.');
    return realFetch(input, init);
  });
});
afterEach(async () => {
  vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});

describe('fresh accounts across real HTTP without a browser wallet extension', () => {
  it('completes private setup, file review, policy history and account recovery without manufacturing public identity', async () => {
    const first = new FreshAccount(), second = new FreshAccount(); const owner = await first.signIn(); await second.signIn();
    expect((await first.state()).agent).toBeNull(); await first.setup('Alice'); await second.setup('Bob');
    const file = await first.call<ContextDocument>('context/files', { name: 'private-context.txt', title: 'Collaboration notes', description: 'Synthetic private context for this flow.',
      mimeType: 'text/plain', contentBase64: Buffer.from('Private synthetic reference. Do not disclose automatically.').toString('base64') });
    expect(file.response.status).toBe(200); expect(file.data).toMatchObject({ sharingScope: 'private-agent', extractionStatus: 'ready', allowAgentContext: false });
    const reviewed = await first.call<ContextDocument>(`context/files/${file.data.id}/update`, { expectedVersion: file.data.version, title: file.data.title, description: file.data.description,
      reviewedExcerpt: 'I write developer documentation.', sharingScope: 'ask-first', allowAgentContext: true, allowOriginalShare: false });
    expect(reviewed.response.status).toBe(200); expect(reviewed.data.version).toBe(2);
    expect((await first.call<unknown[]>('agent/policies')).data).toHaveLength(1);
    expect((await first.call('namespace/claims')).response.status).toBe(200);
    const requested = await first.call('namespace/claim', { label: 'alice', publicNameAndWalletApproved: true });
    expect(requested.response.status).toBe(503); expect(requested.error?.code).toBe('ENS_UNCONFIGURED');
    expect(db().prepare('SELECT id FROM namespace_claims').all()).toEqual([]);
    const snapshot = await first.state(); expect(snapshot.agent?.authority).toBeNull(); expect(snapshot.intents).toEqual([]); expect(snapshot.proposals).toEqual([]);
    expect((await second.state()).profile.contact).toBe('bob@example.invalid'); expect((await second.call<unknown[]>('context/files')).data).toEqual([]);
    expect((await second.call(`context/files/${file.data.id}/download`)).response.status).toBe(404);
    await first.call('auth/logout', {}); await first.signIn(); expect((await first.state()).user.id).toBe(owner.id);
    expect((await first.call<ContextDocument[]>('context/files')).data[0].sharingScope).toBe('ask-first');
    expect(networkRequests.every(url => new URL(url).origin === origin)).toBe(true);
  });

  it('stops draft publication, discovery and qualification at genuine missing authority and provider gates', async () => {
    const owner = new FreshAccount(); await owner.signIn(); await owner.setup('Carol');
    const draft = await owner.call<Intent>('intent', { goal: 'collaborator', summary: 'Find a partner for developer education workshops.', tags: ['developer-education'],
      expiresAt: new Date(Date.now() + 86400000).toISOString(), publicApproved: true, demoOrigin: false });
    expect(draft.response.status).toBe(200); expect(draft.data.status).toBe('draft');
    const publish = await owner.call('intent/publish', { intentId: draft.data.id }); expect(publish.error?.code).toBe('ENS_UNCONFIGURED');
    expect((await owner.call('agent/check', {})).error?.code).toBe('ENS_UNCONFIGURED');
    expect((await owner.call('identity')).error?.code).toBe('ENS_UNCONFIGURED');
    expect((await owner.call('discover', { intentId: draft.data.id })).error?.code).toBe('INTENT_INACTIVE');
    expect((await owner.call('proposals', { intentId: draft.data.id, candidateKey: `0x${'12'.repeat(32)}` })).response.status).toBeGreaterThanOrEqual(400);
    expect((await owner.call('intent/structure', { text: draft.data.summary, providerDisclosureConsent: true })).response.status).toBe(503);
    expect((await owner.call('world/challenge', { proposalId: crypto.randomUUID() })).error?.code).toBe('WORLD_PAUSED');
    expect((await owner.call<unknown[]>('qualifications')).data).toEqual([]);
    const current = await owner.state(); expect(current.intents[0].status).toBe('draft'); expect(current.proposals).toEqual([]); expect(current.rooms).toEqual([]);
    expect(db().prepare('SELECT id FROM operations').all()).toEqual([]); expect(db().prepare('SELECT id FROM world_verifications').all()).toEqual([]);
    expect(networkRequests.every(url => new URL(url).origin === origin)).toBe(true);
  });

  it('rejects replay, stale file edits and cross-account intent access through the same HTTP boundary', async () => {
    const first = new FreshAccount(), second = new FreshAccount(); const signed = await first.signIn(); await second.signIn(); await first.setup('Dana');
    const replay = await first.call('auth/wallet/verify', { id: signed.challengeId, signature: signed.signature }); expect(replay.response.status).toBe(403);
    const draft = await first.call<Intent>('intent', { goal: 'mentor', summary: 'Seeking technical writing mentorship for documentation.', tags: ['documentation'], publicApproved: true,
      expiresAt: new Date(Date.now() + 86400000).toISOString() });
    expect((await second.call('intent/publish', { intentId: draft.data.id })).response.status).toBe(404);
    const file = await first.call<ContextDocument>('context/files', { name: 'notes.txt', mimeType: 'text/plain', contentBase64: Buffer.from('Owner-only notes.').toString('base64') });
    const update = { expectedVersion: file.data.version, reviewedExcerpt: '', allowAgentContext: false, allowOriginalShare: false, title: 'Current owner title' };
    expect((await first.call(`context/files/${file.data.id}/update`, update)).response.status).toBe(200);
    expect((await first.call(`context/files/${file.data.id}/update`, update)).error?.code).toBe('DOCUMENT_CHANGED');
    expect((await second.call(`context/files/${file.data.id}/delete`, { expectedVersion: 2 })).response.status).toBe(404);
    expect((await first.call('account/delete', { confirmation: 'DELETE' })).response.status).toBe(200);
    expect((await first.call('state')).response.status).toBe(401); expect((await second.state()).user.id).not.toBe(signed.id);
    expect(db().prepare('SELECT id FROM private_context_documents').all()).toEqual([]);
  });
});
