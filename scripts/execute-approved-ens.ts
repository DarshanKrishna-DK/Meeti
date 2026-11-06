import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, keccak256, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createParentRegistrationProvider, openParentPlan, type ParentUnsignedTransaction } from '../packages/ens/parent-registration';

const owner = '0x9253705482a44e6A7378163e57cc791AE6213ed5' as Address;
const name = 'meeti-demo.eth';
const cap = parseEther('0.005');
type Entry = { operation: string; hash: Hex; state: 'signed' | 'submitted' | 'confirmed'; maximumFeeWei: string; gasFeeWei?: string; blockNumber?: string };
type Journal = { chainId: 11155111; owner: Address; name: string; capWei: string; entries: Entry[] };
const path = '.local-data/ens-execution-writer.json';
function save(value: Journal) { mkdirSync('.local-data', { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 }); }
async function main() {
  if (!process.argv.includes('--approved-sepolia-batch')) throw new Error('Explicit approved Sepolia batch flag is required.');
  const rpcUrl = process.env.ENS_SEPOLIA_RPC_URL;
  const privateKey = process.env.ARKIV_PRIVATE_KEY;
  if (!rpcUrl || !privateKey) throw new Error('Local signer configuration is missing.');
  const account = privateKeyToAccount(privateKey as Hex);
  if (account.address !== owner) throw new Error('The supplied local key does not match the approved writer.');
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl, { retryCount: 0, timeout: 15000 }) });
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl, { retryCount: 0, timeout: 15000 }) });
  if (await client.getChainId() !== 11155111) throw new Error('Wrong chain.');
  let journal: Journal;
  if (existsSync(path)) {
    try { journal = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error('Existing execution journal is unreadable. Reconcile it before any new signature.'); }
  } else journal = { chainId: 11155111, owner, name, capWei: cap.toString(), entries: [] };
  if (journal.chainId !== 11155111 || journal.owner !== owner || journal.name !== name || journal.capWei !== cap.toString()) throw new Error('Journal identity mismatch.');
  const provider = createParentRegistrationProvider({ rpcUrl });
  const planPath = `.local-data/ens-registration/${owner.toLowerCase()}-meeti-demo.json`;
  const plan = openParentPlan(readFileSync(planPath, 'utf8'), process.env.DATA_ENCRYPTION_KEY);
  async function reconcile(entry: Entry) {
    const receipt = await client.waitForTransactionReceipt({ hash: entry.hash, confirmations: 3, timeout: 120000, pollingInterval: 2500 });
    if (receipt.status !== 'success') throw new Error('A submitted transaction reverted. No automatic retry is permitted.');
    const tx = await client.getTransaction({ hash: entry.hash });
    if (tx.from.toLowerCase() !== owner.toLowerCase() || tx.value !== 0n) throw new Error('Receipt sender or value mismatch.');
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    if (fee > BigInt(entry.maximumFeeWei)) throw new Error('Receipt exceeded its recorded fee bound.');
    entry.state = 'confirmed'; entry.gasFeeWei = fee.toString(); entry.blockNumber = receipt.blockNumber.toString(); save(journal);
    console.log(JSON.stringify({ operation: entry.operation, status: 'confirmed', hash: entry.hash, block: entry.blockNumber, gasFeeWei: entry.gasFeeWei }));
  }
  for (const entry of journal.entries) if (entry.state !== 'confirmed') await reconcile(entry);
  async function send(prepared: ParentUnsignedTransaction) {
    if (prepared.chainId !== 11155111 || prepared.from.toLowerCase() !== owner.toLowerCase() || prepared.value !== '0x0') throw new Error('Prepared transaction does not match approval.');
    const latest = await client.getBlock({ blockTag: 'latest' });
    const estimate = await client.estimateGas({ account, to: prepared.to, data: prepared.data, value: 0n });
    const gas = estimate + estimate / 5n + 1n;
    if (gas > latest.gasLimit / 2n) throw new Error('Gas estimate is above the safe block budget.');
    const fees = await client.estimateFeesPerGas({ type: 'eip1559' });
    const maximumFee = gas * fees.maxFeePerGas;
    const spent = journal.entries.reduce((total, entry) => total + BigInt(entry.gasFeeWei || entry.maximumFeeWei), 0n);
    if (spent + maximumFee > cap) throw new Error('Approved total gas cap would be exceeded.');
    const nonce = await client.getTransactionCount({ address: owner, blockTag: 'pending' });
    if (nonce !== await client.getTransactionCount({ address: owner, blockTag: 'latest' })) throw new Error('Resolve pending transactions before another signature.');
    await client.call({ account, to: prepared.to, data: prepared.data, value: 0n });
    const serialized = await account.signTransaction({ chainId: 11155111, type: 'eip1559', to: prepared.to, data: prepared.data, value: 0n, gas, ...fees, nonce });
    const hash = keccak256(serialized);
    const entry: Entry = { operation: prepared.operation, hash, state: 'signed', maximumFeeWei: maximumFee.toString() };
    journal.entries.push(entry); save(journal);
    // The signed hash is durable before submission. Unknown sends are reconciled, never resent.
    const submitted = await wallet.sendRawTransaction({ serializedTransaction: serialized });
    if (submitted !== hash) throw new Error('Provider returned a different transaction hash.');
    entry.state = 'submitted'; save(journal);
    console.log(JSON.stringify({ operation: prepared.operation, status: 'submitted', hash, chainId: 11155111 }));
    await reconcile(entry);
  }
  for (const tx of (await provider.prepare(name, owner, BigInt(plan.duration), plan)).review.transactions) await send(tx);
  for (let attempt = 0; attempt < 12; attempt++) {
    try { await send((await provider.reveal(plan)).transaction); console.log(JSON.stringify({ name, owner, parentRegistered: true, journal: path })); return; }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'parent_commitment_too_new') throw error;
      console.log(JSON.stringify({ name, status: 'waiting_for_commitment_age', attempt: attempt + 1 }));
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
  throw new Error('Commitment is still too young. Resume without resending confirmed transactions.');
}
main().catch((error: unknown) => { console.error(JSON.stringify({ status: 'stopped', reason: error instanceof Error && /^[A-Za-z0-9 ._-]{1,160}$/.test(error.message) ? error.message : 'Provider or validation failure. Reconcile the durable journal before continuing.', journal: path })); process.exitCode = 1; });
