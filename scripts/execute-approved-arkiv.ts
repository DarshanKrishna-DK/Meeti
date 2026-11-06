import { existsSync, openSync, closeSync, fsyncSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, keccak256, type Hex } from 'viem';
import { rabdi } from '@arkiv-network/sdk/chains';
import { decrypt } from '../packages/server/crypto';
import { authority } from '../packages/server/policy';
import type { PreparedArkivTransaction } from '../packages/arkiv/src';

class ExecutionStop extends Error {}
const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:3173';
const requestedRole = process.argv[3] || 'writer';
if (requestedRole !== 'writer' && requestedRole !== 'metamask') throw new ExecutionStop('Choose the exact approved wallet role.');
const role = requestedRole;
const wallets = { writer: '0x9253705482a44e6A7378163e57cc791AE6213ed5', metamask: '0xEE291Bc0246441F53610FbCAF2bC892110e72732' } as const;
const accounts = decrypt<Record<string, { userId: string; cookie: string }>>(readFileSync('.local-data/live-matching-accounts.enc', 'utf8'), 'live-matching-accounts');
const reviewText = readFileSync('artifacts/arkiv-matching-review.json', 'utf8');
const review = JSON.parse(reviewText) as { chainId: number; maximumTotalFeePerWalletWei: string; review: { id: string; role: string; signingMessage: string }[] };
const reviewHash = createHash('sha256').update(reviewText).digest('hex');
if (review.chainId !== 7794095 || review.maximumTotalFeePerWalletWei !== '10000000000000000') throw new ExecutionStop('The approved network or fee cap changed.');
const journalPath = `.local-data/arkiv-execution-${role}.json`;
type Entry = { intentId: string; operationId: string; transaction: PreparedArkivTransaction; state: string; hash?: Hex; signedTransaction?: Hex; actualFeeWei?: string; entityKey?: string };
type Journal = { chainId: number; owner: string; approvedReviewHash: string; maximumTotalFeeWei: string; entries: Entry[]; cancelledEntries?: Entry[] };
const journal: Journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : { chainId: 7794095, owner: wallets[role], approvedReviewHash: reviewHash, maximumTotalFeeWei: review.maximumTotalFeePerWalletWei, entries: [] };
if (journal.approvedReviewHash !== reviewHash || journal.owner !== wallets[role] || journal.chainId !== 7794095) throw new ExecutionStop('The durable approval journal does not match this review.');
function save() { writeFileSync(journalPath, JSON.stringify(journal, null, 2), { mode: 0o600 }); const fd = openSync(journalPath, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } }
async function api<T>(endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(origin + '/api/' + endpoint, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, cookie: accounts[role].cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
  const result = await response.json();
  if (!response.ok) throw new ExecutionStop(`Application ${endpoint} failed: ${result.error?.code || response.status}. No transaction retry is permitted.`);
  return result.data as T;
}
function remaining() {
  const reserved = journal.entries.reduce((sum, entry) => sum + BigInt(entry.actualFeeWei ?? (entry.state === 'prepared' || entry.state === 'signed' || entry.state === 'submitted' ? entry.transaction.maximumFeeWei : '0')), 0n);
  return BigInt(journal.maximumTotalFeeWei) - reserved;
}
async function prepare() {
  const item = review.review.find(value => value.role === role && !journal.entries.some(entry => entry.intentId === value.id));
  if (!item) { console.log('All reviewed intents for this wallet already have durable operations.'); return; }
  if (journal.entries.some(entry => entry.state !== 'confirmed')) throw new ExecutionStop('Reconcile the existing operation before preparing another.');
  const preview = await api<{ signingMessage: string }>('intent/publish', { intentId: item.id });
  if (preview.signingMessage !== item.signingMessage) throw new ExecutionStop('The public intent differs from the owner-approved review.');
  let signature: Hex;
  if (role === 'writer') {
    const key = process.env.ARKIV_PRIVATE_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new ExecutionStop('Configure the approved local signer securely.');
    const account = privateKeyToAccount(key as Hex);
    if (account.address.toLowerCase() !== wallets.writer.toLowerCase()) throw new ExecutionStop('The configured signer differs from the approved wallet.');
    signature = await account.signMessage({ message: preview.signingMessage });
  } else {
    const file = `.local-data/arkiv-meta-signature-${item.id}.json`;
    if (!existsSync(file)) {
      writeFileSync('.local-data/arkiv-meta-signing-review.json', JSON.stringify({ chainId: 7794095, owner: wallets.metamask, intentId: item.id, signingMessage: preview.signingMessage, outputFile: file }, null, 2));
      console.log('The reviewed MetaMask public-intent signing request is ready locally.'); return;
    }
    signature = JSON.parse(readFileSync(file, 'utf8')).signature;
  }
  const result = await api<{ operationId: string; transaction: PreparedArkivTransaction }>('intent/publish', { intentId: item.id, signature, maxFeeWei: remaining().toString() });
  const entry: Entry = { intentId: item.id, ...result, state: 'prepared' };
  journal.entries.push(entry); save();
  if (role === 'metamask') writeFileSync('.local-data/arkiv-meta-transaction-review.json', JSON.stringify({ ...entry, maximumTotalFeeWei: journal.maximumTotalFeeWei, owner: wallets.metamask }, null, 2));
  console.log(JSON.stringify({ state: 'prepared', chainId: 7794095, owner: wallets[role], intentId: item.id, operationId: entry.operationId, maximumFeeWei: entry.transaction.maximumFeeWei }));
}
const client = createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY || '' }), cacheTime: 0,
  transport: http(undefined, { retryCount: 0, timeout: 12_000, fetchOptions: { cache: 'no-store', redirect: 'error' } }) });
async function confirm() {
  const entry = journal.entries.find(value => value.state !== 'confirmed');
  if (!entry?.hash) throw new ExecutionStop('No submitted hash is recorded. Never create a replacement transaction.');
  const receipt = await client.waitForTransactionReceipt({ hash: entry.hash, confirmations: 2, timeout: 90_000 });
  entry.actualFeeWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
  if (receipt.status !== 'success') { entry.state = 'reverted'; save(); throw new ExecutionStop('The transaction reverted. No automatic signature or retry is permitted.'); }
  entry.state = 'receipt_confirmed'; save();
  await api(`operations/${entry.operationId}/submitted`, { transactionHash: entry.hash });
  const result = await api<{ entityKey: string }>('intent/confirm', { intentId: entry.intentId, operationId: entry.operationId, txHash: entry.hash });
  entry.entityKey = result.entityKey; entry.state = 'confirmed'; save();
  console.log(JSON.stringify({ state: 'confirmed', chainId: 7794095, transactionHash: entry.hash, entityKey: entry.entityKey, blockNumber: receipt.blockNumber.toString(), actualFeeWei: entry.actualFeeWei }));
}
async function sendWriter() {
  if (role !== 'writer' || !process.argv.includes('--approved-rabdi-test-publications')) throw new ExecutionStop('The exact approved local writer execution flag is required.');
  const entry = journal.entries.find(value => value.state !== 'confirmed');
  if (!entry || entry.state !== 'prepared' || entry.hash) throw new ExecutionStop('Only one prepared, never-submitted operation may be signed. Reconcile uncertain hashes without resending.');
  await authority(accounts.writer.userId, 'publish'); await api('state');
  const tx = entry.transaction;
  const operations = await api<{ id: string; data: { transaction?: PreparedArkivTransaction } }[]>('operations');
  const trusted = operations.find(value => value.id === entry.operationId)?.data.transaction;
  if (!trusted || JSON.stringify(trusted) !== JSON.stringify(tx) || tx.chainId !== 7794095 || tx.request.chainId !== '0x76edaf'
    || tx.request.to.toLowerCase() !== '0x4400000000000000000000000000000000000044' || tx.request.from.toLowerCase() !== wallets.writer.toLowerCase() || tx.request.value !== '0x0') throw new ExecutionStop('The signing request differs from the authenticated prepared operation.');
  if (Date.now() >= Date.parse(tx.expiresAt)) throw new ExecutionStop('The unsigned quote expired before signing. Cancel only after confirming it was never submitted.');
  const [chainId, block, latestNonce, pendingNonce, balance, gasPrice, estimate] = await Promise.all([
    client.getChainId(), client.getBlock({ blockTag: 'latest' }), client.getTransactionCount({ address: wallets.writer, blockTag: 'latest' }),
    client.getTransactionCount({ address: wallets.writer, blockTag: 'pending' }), client.getBalance({ address: wallets.writer, blockTag: 'latest' }),
    client.getGasPrice(), client.estimateGas({ account: wallets.writer, to: tx.request.to, data: tx.request.data, value: 0n, blockTag: 'latest' }),
  ]);
  const gas = BigInt(tx.request.gas), price = BigInt(tx.request.gasPrice);
  if (chainId !== 7794095 || latestNonce !== pendingNonce || latestNonce !== Number(BigInt(tx.request.nonce)) || gas > block.gasLimit / 2n
    || gas < 1_000_000n || gas < 2n * estimate || gasPrice !== price || gas * price > balance || remaining() < 0n) throw new ExecutionStop('Fresh network, nonce, gas or approved fee checks failed before signing.');
  const account = privateKeyToAccount(process.env.ARKIV_PRIVATE_KEY as Hex);
  if (account.address.toLowerCase() !== wallets.writer.toLowerCase() || tx.account.toLowerCase() !== wallets.writer.toLowerCase()) throw new ExecutionStop('The approved signer changed.');
  const signed = await account.signTransaction({ chainId, type: 'legacy', nonce: latestNonce, gas, gasPrice: price, to: tx.request.to, data: tx.request.data, value: 0n });
  entry.hash = keccak256(signed); entry.signedTransaction = signed; entry.state = 'signed'; save();
  const hash = await client.sendRawTransaction({ serializedTransaction: signed });
  if (hash !== entry.hash) throw new ExecutionStop('The provider returned a different hash. Preserve the journal and stop.');
  entry.state = 'submitted'; save();
  console.log(JSON.stringify({ state: 'submitted', chainId, transactionHash: hash }));
  await confirm();
}
async function recordMeta() {
  if (role !== 'metamask') throw new ExecutionStop('Only the approved browser wallet can supply this external submission.');
  const result = JSON.parse(readFileSync('.local-data/arkiv-meta-submission.json', 'utf8')) as { intentId: string; operationId: string; transactionHash: Hex };
  const entry = journal.entries.find(value => value.intentId === result.intentId && value.operationId === result.operationId);
  if (!entry || !/^0x[0-9a-fA-F]{64}$/.test(result.transactionHash) || (entry.hash && entry.hash !== result.transactionHash)) throw new ExecutionStop('The browser submission does not match the prepared operation.');
  if (entry.state === 'confirmed') { console.log('This exact browser operation is already confirmed.'); return; }
  const tx = await client.getTransaction({ hash: result.transactionHash });
  if (tx.from.toLowerCase() !== wallets.metamask.toLowerCase() || tx.to?.toLowerCase() !== entry.transaction.request.to.toLowerCase()
    || tx.input !== entry.transaction.request.data || tx.value !== 0n || tx.nonce !== Number(BigInt(entry.transaction.request.nonce))) throw new ExecutionStop('The browser transaction differs from the owner-reviewed publication.');
  entry.hash = result.transactionHash; entry.state = 'submitted'; save();
  await confirm();
}
async function recoverUnrequested() {
  if (!process.argv.includes('--confirmed-not-requested')) throw new ExecutionStop('Require a definitive wallet-not-requested observation, not a missing receipt or hash.');
  const entry = journal.entries.find(value => value.state !== 'confirmed');
  if (!entry || entry.state !== 'prepared' || entry.hash || entry.signedTransaction) throw new ExecutionStop('Only a never-requested prepared operation can be cancelled. Unknown or submitted transactions must be reconciled.');
  const operations = await api<{ id: string; state: string }[]>('operations');
  if (operations.find(value => value.id === entry.operationId)?.state !== 'prepared') throw new ExecutionStop('The application operation is not a never-submitted preparation.');
  const [nonce, pending] = await Promise.all([client.getTransactionCount({ address: wallets[role], blockTag: 'latest' }), client.getTransactionCount({ address: wallets[role], blockTag: 'pending' })]);
  if (nonce !== pending || nonce !== Number(BigInt(entry.transaction.request.nonce))) throw new ExecutionStop('The wallet nonce changed. Reconcile instead of preparing another transaction.');
  await api(`operations/${entry.operationId}/cancel`, { confirmation: 'NOT_SUBMITTED' });
  entry.state = 'cancelled_before_wallet_request';
  (journal.cancelledEntries ??= []).push(entry); journal.entries = journal.entries.filter(value => value !== entry); save();
  console.log('The definitively unrequested operation was cancelled and archived. A fresh quote for the same approved intent may now be prepared.');
}
try {
  if (process.argv[2] === 'prepare') await prepare();
  else if (process.argv[2] === 'send-writer') await sendWriter();
  else if (process.argv[2] === 'confirm') await confirm();
  else if (process.argv[2] === 'record-meta') await recordMeta();
  else if (process.argv[2] === 'recover-unrequested') await recoverUnrequested();
  else throw new ExecutionStop('Choose prepare, send-writer, or confirm with an explicit wallet role.');
} catch (error) { if(error instanceof ExecutionStop) console.error(error.message); console.error('Approved Arkiv operation stopped. Preserve the durable journal; inspect its phase and known public hash without resending. Provider details are withheld to protect the keyed endpoint.'); process.exitCode = 1; }
