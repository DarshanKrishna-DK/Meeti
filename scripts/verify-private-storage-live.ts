import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { bootstrapPrivateContextBucket } from '../packages/server/supabase-storage';
import { closeDatabase, db } from '../packages/server/db';
import { decrypt } from '../packages/server/crypto';
import { route } from '../packages/server/router';

const runId = randomUUID();
process.env.DATABASE_PATH = `.local-data/storage-live-${runId}.sqlite`;
process.env.SUPABASE_STORAGE_ENABLED = 'true';
process.env.APP_ORIGIN = 'http://127.0.0.1:3198';
const origin = process.env.APP_ORIGIN;
async function call(path: string, cookie?: string, body?: unknown) {
  return route(new Request(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split('/'));
}
async function account() {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const challenge = await call('auth/wallet/challenge', undefined, { address: wallet.address, chainId: 11155111 });
  const { data } = await challenge.json();
  if (challenge.status !== 200) throw new Error('Synthetic wallet challenge failed.');
  const cookie = challenge.headers.getSetCookie().find(value => value.startsWith('meeti_wallet_flow='))!.split(';')[0];
  const signed = await call('auth/wallet/verify', cookie, { id: data.id, signature: await wallet.signMessage({ message: data.message }) });
  if (signed.status !== 200) throw new Error('Synthetic wallet authentication failed.');
  return { id: (await signed.json()).data.id as string, cookie: signed.headers.getSetCookie().find(value => value.startsWith('meeti_session='))!.split(';')[0] };
}
const created: { owner: Awaited<ReturnType<typeof account>>; document: { id: string; version: number } }[] = [];
try {
  const bucket = await bootstrapPrivateContextBucket();
  const left = await account(), right = await account();
  for (const owner of [left, right]) {
    const response = await call('context/files', owner.cookie, { name: 'synthetic-test.txt', mimeType: 'text/plain', contentBase64: Buffer.from(`Synthetic private storage test ${runId} ${owner.id}. No real personal data.`).toString('base64') });
    if (response.status !== 200) throw new Error(`Live cloud upload route failed (${response.status}).`);
    created.push({ owner, document: (await response.json()).data });
  }
  const target = created[0];
  const original = await call(`context/files/${target.document.id}/download`, left.cookie);
  if (original.status !== 200 || !(await original.text()).includes(runId)) throw new Error('Owner cloud read-back did not match.');
  const crossUser = await call(`context/files/${target.document.id}/download`, right.cookie);
  if (crossUser.status !== 404) throw new Error('Cross-account document access was not denied.');
  const row = db().prepare('SELECT content FROM private_context_documents WHERE id=?').get(target.document.id) as { content: string };
  const pointer = decrypt<{ bucket: string; path: string }>(row.content, `context-content:${left.id}:${target.document.id}`);
  const publicRead = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/public/${pointer.bucket}/${pointer.path}`);
  if (publicRead.ok) throw new Error('Public original object access must be denied.');
  const anonRead = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/authenticated/${pointer.bucket}/${pointer.path}`, {
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}` },
  });
  if (anonRead.ok) throw new Error('A publishable key must not retrieve a private original.');
  const report = { runId, checkedAt: new Date().toISOString(), bucket, authenticatedTestWallets: 2, actualCloudUploads: 2,
    ownerReadBack: original.status, crossUserDenied: crossUser.status, publicObjectDenied: publicRead.status, publishableObjectDenied: anonRead.status,
    scope: 'Actual nonce signatures, local sessions, encrypted Supabase SDK writes/reads and tenant denial. No ENS/Arkiv matching or independent human/device acceptance implied.' };
  mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/supabase-storage-live.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch { console.error('Private storage live verification failed. No successful cloud integration is assumed.'); process.exitCode = 1; }
finally {
  for (const value of created) {
    const deleted = await call(`context/files/${value.document.id}/delete`, value.owner.cookie, { expectedVersion: value.document.version });
    if (deleted.status !== 200) { console.error('Synthetic cloud cleanup is pending in its encrypted operation journal.'); process.exitCode = 1; }
  }
  closeDatabase();
}
