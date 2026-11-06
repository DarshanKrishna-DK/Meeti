import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createEnsAuthorityProvider, dnsEncode, encodeInlinePolicyUri, inlinePolicyDigest, type EnsOperation, type PreparedEnsTransaction } from '../packages/ens';
import { resolverAbi } from '../packages/ens/abi';
import { isForbiddenTextRoleRevert } from '../packages/ens/revert-verification';
import { createEnsReadTransport } from '../packages/ens/rpc-transport';
import type { Policy } from '../packages/shared/src';

const owner = '0x9253705482a44e6A7378163e57cc791AE6213ed5' as Address;
const delegate = '0xEE291Bc0246441F53610FbCAF2bC892110e72732' as Address;
const name = 'agent.meeti-demo.eth';
const peerName = 'agent.crypteck.eth';
const cap = parseEther('0.005');
const journalPath = '.local-data/ens-execution-writer.json';
const scopePath = '.local-data/ens-network-policy.json';
let disconnect: (() => Promise<void>) | undefined;
let disconnectReadClient: (() => Promise<void>) | undefined;
type Entry = { operation: string; hash: Hex; state: 'signed' | 'submitted' | 'confirmed'; maximumFeeWei: string; gasFeeWei?: string; blockNumber?: string };
type Journal = { chainId: number; owner: Address; capWei: string; entries: Entry[]; evidence?: unknown[] };
function save(value: Journal) { writeFileSync(journalPath, JSON.stringify(value, null, 2), { mode: 0o600 }); }
async function main() {
  if (!process.argv.includes('--approved-sepolia-batch')) throw new Error('Approved Sepolia batch flag required.');
  const phase = process.argv[2];
  if (!['setup', 'update-peer', 'revoke', 'restore', 'verify'].includes(phase)) throw new Error('Choose an approved setup phase.');
  const cycleIndex = process.argv.indexOf('--cycle');
  const cycleValue = cycleIndex < 0 ? '1' : process.argv[cycleIndex + 1];
  if (!/^[1-4]$/.test(cycleValue || '') || (cycleIndex >= 0 && !['revoke', 'restore'].includes(phase))) throw new Error('Choose a supported explicit revoke/restore cycle from 1 to 4.');
  const cycle = Number(cycleValue);
  const rpcUrl = process.env.ENS_SEPOLIA_RPC_URL;
  if (!rpcUrl || !process.env.ARKIV_PRIVATE_KEY) throw new Error('Local signer configuration missing.');
  const account = privateKeyToAccount(process.env.ARKIV_PRIVATE_KEY as Hex);
  if (account.address !== owner) throw new Error('Signer does not match approved writer.');
  const readRpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || rpcUrl;
  const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(readRpcUrl) });
  disconnectReadClient = async () => {
    const transport = client.transport as { getRpcClient?: () => Promise<{ close(): void }>; getSocket?: () => Promise<{ close(): void }> };
    if (transport.getRpcClient) (await transport.getRpcClient()).close();
    else if (transport.getSocket) (await transport.getSocket()).close();
  };
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl, { retryCount: 0, timeout: 15000 }) });
  if (await client.getChainId() !== 11155111) throw new Error('Wrong network.');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  if (journal.chainId !== 11155111 || journal.owner !== owner || journal.capWei !== cap.toString()) throw new Error('Journal scope mismatch.');
  const policy: Policy = existsSync(scopePath) ? JSON.parse(readFileSync(scopePath, 'utf8')) : {
    version: 1, purpose: 'collaborator', allowedFields: ['headline', 'bio', 'offering', 'seeking', 'tags'],
    allowedActions: ['publish', 'discover', 'evaluate', 'negotiate', 'introduce', 'message'],
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), paused: false,
  };
  if (!existsSync(scopePath)) writeFileSync(scopePath, JSON.stringify(policy, null, 2));
  const digest = inlinePolicyDigest(policy);
  const provider = createEnsAuthorityProvider({ rpcUrl: process.env.ENS_SEPOLIA_AUTH_RPC_URL || rpcUrl });
  disconnect = provider.disconnect;
  async function reconcile(entry: Entry) {
    const receipt = await client.waitForTransactionReceipt({ hash: entry.hash, confirmations: 3, timeout: 120000, pollingInterval: 2500 });
    if (receipt.status !== 'success') throw new Error('Submitted transaction reverted; no automatic retry.');
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    if (fee > BigInt(entry.maximumFeeWei)) throw new Error('Receipt fee bound mismatch.');
    entry.state = 'confirmed'; entry.gasFeeWei = fee.toString(); entry.blockNumber = receipt.blockNumber.toString(); save(journal);
    console.log(JSON.stringify({ operation: entry.operation, status: 'confirmed', hash: entry.hash, block: entry.blockNumber, gasFeeWei: entry.gasFeeWei }));
  }
  for (const entry of journal.entries) if (entry.state !== 'confirmed') await reconcile(entry);
  async function prepare(operation: EnsOperation, ensName = name, extra: { value?: string; key?: string } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await provider.prepareTransaction({ operation, ensName, owner: ensName === name ? owner : delegate, delegate: ensName === name ? delegate : owner,
        expiresAt: Math.floor(Date.parse(policy.expiresAt) / 1000), ...extra }); }
      catch (error) {
        let cause = error as { code?: unknown; name?: string; message?: string; cause?: unknown };
        let transient = false;
        for (let depth = 0; cause && depth < 8; depth++, cause = cause.cause as typeof cause) {
          if (cause.code === -32001 || cause.name === 'TimeoutError' || cause.name === 'HttpRequestError' || cause.message === 'ens_verification_failed') transient = true;
        }
        if (!transient || attempt === 2) throw error;
        console.log(JSON.stringify({ status: 'retrying_read_only_tip_snapshot', operation }));
        await provider.disconnect();
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    throw new Error('Preparation unavailable.');
  }
  async function send(operation: string, tx: PreparedEnsTransaction) {
    if (journal.entries.some(entry => entry.operation === operation && entry.state === 'confirmed')) return;
    if (tx.chainId !== 11155111 || tx.from.toLowerCase() !== owner.toLowerCase() || tx.value !== '0x0') throw new Error('Prepared request outside approved signer scope.');
    const block = await client.getBlock({ blockTag: 'latest' });
    const estimate = await client.estimateGas({ account, to: tx.to, data: tx.data, value: 0n });
    const gas = estimate + estimate / 5n + 1n;
    if (gas > block.gasLimit / 2n) throw new Error('Gas exceeds half block limit.');
    const fees = await client.estimateFeesPerGas({ type: 'eip1559' });
    const maximum = gas * fees.maxFeePerGas;
    const spent = journal.entries.reduce((total, entry) => total + BigInt(entry.gasFeeWei || entry.maximumFeeWei), 0n);
    if (spent + maximum > cap) throw new Error('Approved total gas cap exceeded.');
    const nonce = await client.getTransactionCount({ address: owner, blockTag: 'pending' });
    if (nonce !== await client.getTransactionCount({ address: owner, blockTag: 'latest' })) throw new Error('Unresolved pending nonce.');
    await client.call({ account, to: tx.to, data: tx.data, value: 0n });
    const serialized = await account.signTransaction({ chainId: 11155111, type: 'eip1559', to: tx.to, data: tx.data, value: 0n, gas, ...fees, nonce });
    const hash = keccak256(serialized);
    const entry: Entry = { operation, hash, state: 'signed', maximumFeeWei: maximum.toString() };
    journal.entries.push(entry); save(journal);
    if (await wallet.sendRawTransaction({ serializedTransaction: serialized }) !== hash) throw new Error('Hash mismatch.');
    entry.state = 'submitted'; save(journal);
    console.log(JSON.stringify({ operation, status: 'submitted', hash }));
    await reconcile(entry);
  }
  if (phase === 'setup') {
    for (const operation of ['deploy-registry', 'set-subregistry', 'create-subname', 'deploy-resolver', 'set-resolver', 'set-policy', 'grant'] as EnsOperation[]) {
      const id = name + ':' + operation;
      if (journal.entries.some(entry => entry.operation === id && entry.state === 'confirmed')) continue;
      const value = operation === 'set-policy' ? JSON.stringify({ version: String(policy.version), ensName: name, owner, delegate, digest,
        uri: encodeInlinePolicyUri(policy), expiresAt: Math.floor(Date.parse(policy.expiresAt) / 1000), actions: [...policy.allowedActions, 'update-status'], resolverScope: 'dedicated-agent' }) : undefined;
      await send(id, await prepare(operation, name, { value }));
    }
  } else if (phase === 'update-peer') {
    await send(peerName + ':delegate-update', await prepare('update-status', peerName, { value: JSON.stringify({ schema: 'meeti.agent-card.v1', ensName: peerName,
      owner: delegate, delegate: owner, persona: 'A Meeti representative that shares only approved public context.', capabilities: policy.allowedActions, policyVersion: policy.version, policyDigest: digest }) }));
  } else if (phase === 'revoke' || phase === 'restore') {
    const operationId = name + ':' + phase + (cycle === 1 ? '' : ':cycle-' + cycle);
    if (!journal.entries.some(entry => entry.operation === operationId && entry.state === 'confirmed') && phase === 'revoke') {
      const before = await provider.checkAuthority({ ensName: name, owner, delegate, action: 'negotiate', policyVersion: policy.version, policyDigest: digest });
      if (!before.allowed) throw new Error('A fresh verified grant is required before recording another revocation cycle.');
      journal.evidence ??= []; journal.evidence.push({ phase: 'before-revoke', cycle, ...before }); save(journal);
    }
    if (!journal.entries.some(entry => entry.operation === operationId && entry.state === 'confirmed') && phase === 'restore') {
      const revokeId = name + ':revoke' + (cycle === 1 ? '' : ':cycle-' + cycle);
      if (!journal.entries.some(entry => entry.operation === revokeId && entry.state === 'confirmed')) throw new Error('Confirm the matching revocation cycle before restoration.');
      const before = await provider.checkAuthority({ ensName: name, owner, delegate, action: 'negotiate', policyVersion: policy.version, policyDigest: digest });
      if (before.allowed || before.reason !== 'delegation_revoked_or_missing') throw new Error('A fresh verified revocation is required before restoration.');
    }
    await send(operationId, await prepare(phase === 'revoke' ? 'revoke' : 'grant'));
  }
  const status = await provider.checkAuthority({ ensName: name, owner, delegate, action: 'negotiate', policyVersion: policy.version, policyDigest: digest });
  journal.evidence ??= []; journal.evidence.push({ phase, cycle, ...status }); save(journal);
  console.log(JSON.stringify({ phase, cycle, ensName: name, authority: status, policyFile: scopePath }));
  if (phase === 'revoke' && (status.allowed || status.reason !== 'delegation_revoked_or_missing')) throw new Error('Revocation was not independently established.');
  if (phase === 'setup' || phase === 'restore' || phase === 'verify') {
    if (!status.allowed) throw new Error('Current verified authority unavailable.');
    const allowedValue = JSON.stringify({ schema: 'meeti.agent-card.v1', ensName: name,
      owner, delegate, persona: 'A Meeti representative that shares only approved public context.', capabilities: policy.allowedActions,
      policyVersion: policy.version, policyDigest: digest });
    const allowedData = encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(name), 'network.agent.status', allowedValue] });
    await client.call({ account: delegate, to: status.evidence!.resolver, data: allowedData, value: 0n });
    journal.evidence.push({ ensName: name, allowedRecord: 'network.agent.status', delegate, actualReadOnlyEvmSimulationSucceeded: true, noTransactionSent: true }); save(journal);
    console.log(JSON.stringify({ ensName: name, allowedStatusSimulationSucceeded: true, delegate, noTransactionSent: true }));
    const data = encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(name), 'network.agent.policy', 'forbidden-test-no-write'] });
    let permissionReverted = false;
    try { await client.call({ account: delegate, to: status.evidence!.resolver, data, value: 0n }); }
    catch (error) { permissionReverted = isForbiddenTextRoleRevert(error, delegate, 'network.agent.policy'); }
    if (!permissionReverted) throw new Error('Forbidden policy write was not proven rejected by EAC.');
    journal.evidence.push({ ensName: name, forbiddenRecord: 'network.agent.policy', actualOnchainCallReverted: true, decodedError: 'EACUnauthorizedAccountRoles', rejectedAccount: delegate, noTransactionSent: true }); save(journal);
    console.log(JSON.stringify({ ensName: name, forbiddenPolicyUpdateRejected: true, actualReadOnlyEvmSimulation: true }));
  }
}
main().catch((error: unknown) => {
  const causes = [];
  let cause = error as { name?: string; code?: unknown; shortMessage?: string; message?: string; cause?: unknown };
  for (let i = 0; cause && i < 6; i++, cause = cause.cause as typeof cause) {
    let message = String(cause.shortMessage || cause.message || '').split('\n')[0].slice(0, 200);
    for (const secret of [process.env.ARKIV_PRIVATE_KEY, process.env.DATA_ENCRYPTION_KEY]) if (secret) message = message.replaceAll(secret, '[REDACTED_SECRET]');
    causes.push({ name: cause.name, code: cause.code, message: message.replace(/(?:https?|wss?):\/\/\S+/g, '[RPC]') });
  }
  console.error(JSON.stringify({ status: 'stopped', journal: journalPath, causes, automaticResend: false })); process.exitCode = 1;
}).finally(async () => { await disconnect?.().catch(() => undefined); await disconnectReadClient?.().catch(() => undefined); });
