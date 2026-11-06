'use client';
import { useCallback, useEffect, useState } from 'react';
import type { AppState } from '@/packages/shared/src';
import { findMetaMask } from './metamask';
import { api } from './workspace-features';
type Claim = { id: string; version: number; label: string; state: string; recipient: string; userName: string; agentName: string; recipientRegistry?: string; userRegistry?: string; agentConfirmed: false; receipts: { hash: string; operation: string; blockNumber: string }[] };
type Operation = { operationId: string; expiresAt: string; maxFeeWei: string; submittedHash?: string; transaction: { from: string; to: string; data: string; gas: string; gasPrice: string; operation: string; ensName: string; warning?: string } };
type Overview = { parent: string; branch: string; issuer: string; isOperator: boolean; claim: Claim | null; requests: Claim[]; operations: Operation[]; custody: string; sponsorship: string };
export function NameClaimPanel({ state, onUpdated }: { state: AppState; onUpdated?: () => void }) { return <OwnerNameClaimPanel key={state.user.id} state={state} onUpdated={onUpdated} />; }
function OwnerNameClaimPanel({ state, onUpdated }: { state: AppState; onUpdated?: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null), [label, setLabel] = useState(''), [consent, setConsent] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null), [reviewed, setReviewed] = useState(false), [hash, setHash] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [setup, setSetup] = useState<unknown>(null);
  const load = useCallback(async () => { const result = await api<Overview>('namespace/claims'); setOverview(result); setOperation(result.operations[0] || null); setHash(result.operations[0]?.submittedHash || ''); }, []);
  useEffect(() => { let active = true; void Promise.resolve().then(() => { if (active) return load(); }).catch(failure => { if (active) setError(failure.message); }); return () => { active = false; }; }, [load]);
  async function run(work: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'The name request failed. Refresh and retry.'); } finally { setBusy(false); } }
  async function prepare(path: string, input: object) { const result = await api<Operation & { needed?: boolean; inspected?: unknown }>(path, { ...input, maxFeeWei: '500000000000000' }); if (result.needed === false) { setSetup(result.inspected); setNotice('The project namespace is already ready.'); } else { setOperation(result); setReviewed(false); setHash(''); } }
  async function send() {
    if (!operation || !reviewed || operation.submittedHash || Date.parse(operation.expiresAt) <= Date.now()) throw new Error('Review a fresh unsigned transaction before signing.');
    const wallet = await findMetaMask(), accounts = await wallet.request({ method: 'eth_accounts' }) as string[];
    if (!accounts.some(account => account.toLowerCase() === operation.transaction.from.toLowerCase()) || state.user.wallet?.toLowerCase() !== operation.transaction.from.toLowerCase()) throw new Error('Select the authenticated project issuer in MetaMask.');
    if (BigInt(String(await wallet.request({ method: 'eth_chainId' }))) !== 11155111n) throw new Error('Switch MetaMask to Sepolia first.');
    const { from, to, data, gas, gasPrice } = operation.transaction;
    if (BigInt(gas) * BigInt(gasPrice) > BigInt(operation.maxFeeWei)) throw new Error('The transaction exceeds the reviewed fee cap.');
    const txHash = String(await wallet.request({ method: 'eth_sendTransaction', params: [{ from, to, data, gas, gasPrice, value: '0x0' }] }));
    setHash(txHash); setOperation({ ...operation, submittedHash: txHash });
    await api('namespace/submitted', { operationId: operation.operationId, hash: txHash });
  }
  return <section className="panel stack"><div><p className="eyebrow">Your networking name</p><h2>Request your own Meeti name.</h2><p>Choose a public name linked to your authenticated wallet. A request reserves a label locally. It becomes yours on Sepolia only after the issuer transaction is confirmed.</p></div>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button className="button secondary" disabled={busy} onClick={() => void run(load)}>Refresh name request</button>
    {overview && <><p>{overview.custody}</p><p>{overview.sponsorship}</p>
      {overview.claim && <div className="stack"><h3>{overview.claim.userName}</h3><p>Status: {overview.claim.state === 'confirmed' ? 'User-name issuance confirmed. Agent setup remains separate.' : overview.claim.state}</p><p>Planned agent name: <span className="mono">{overview.claim.agentName}</span></p>
        {overview.claim.recipientRegistry && <p className="mono">Recipient registry: {overview.claim.recipientRegistry}</p>}
        {overview.claim.receipts.map(receipt => <a key={receipt.hash} href={`https://sepolia.etherscan.io/tx/${receipt.hash}`} target="_blank" rel="noreferrer">{receipt.operation}, confirmed block {receipt.blockNumber}</a>)}
        {overview.claim.state === 'requested' && <button className="button secondary" disabled={busy} onClick={() => void run(async () => { await api('namespace/withdraw', { version: overview.claim!.version }); await load(); })}>Withdraw unsigned request</button>}
      </div>}
      {(!overview.claim || ['requested', 'withdrawn'].includes(overview.claim.state)) && <><label>Preferred user label<input maxLength={63} value={label} onChange={event => setLabel(event.target.value)} placeholder="your-name" /></label><p className="mono">{label.trim().toLowerCase() || 'your-name'}.{overview.branch}</p>
        <label className="check-row"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />I approve the selected name and my wallet address becoming public on Sepolia. Parent control and gas requirements are explained above.</label>
        <button className="button" disabled={busy || !consent || !label.trim()} onClick={() => void run(async () => { const result = await api<{ availability?: { confirmedAvailable: boolean; reason?: string } }>('namespace/claim', { label, publicNameAndWalletApproved: true }); await load(); setNotice(result.availability?.confirmedAvailable ? 'Availability checked on Sepolia. Issuer confirmation is still required.' : result.availability?.reason || 'The existing owner request was recovered.'); setConsent(false); })}>Request and check this label</button></>}
      {overview.isOperator && <details><summary>Project issuer controls</summary><div className="stack"><p>These actions require your issuer wallet and explicit MetaMask approval. Each review caps fees at 0.0005 test ETH. No server signing key is used.</p>
        <div className="button-row"><button className="button secondary" disabled={busy} onClick={() => void run(async () => setSetup(await api('namespace/setup', {})))}>Inspect current project control</button><button className="button secondary" disabled={busy || Boolean(operation)} onClick={() => void run(() => prepare('namespace/prepare-branch', {}))}>Review next namespace setup step</button></div>
        {setup != null && <details><summary>Current chain inspection</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(setup, null, 2)}</pre></details>}
        {overview.requests.length === 0 && <p>No recipient name requests are waiting.</p>}
        {overview.requests.filter(claim => claim.state !== 'confirmed').map(claim => <div key={claim.id} className="stack"><h3>{claim.userName}</h3><p className="mono">Recipient: {claim.recipient}</p><p>Current request version {claim.version}. The recipient retains all roles in its dedicated registry.</p><button className="button secondary" disabled={busy || Boolean(operation)} onClick={() => void run(() => prepare('namespace/prepare-claim', { claimId: claim.id, version: claim.version }))}>Review next issuance step</button></div>)}
      </div></details>}
    </>}
    {operation && <div className="stack"><h3>{operation.submittedHash ? 'Transaction submitted. Confirmation pending.' : 'Review the exact unsigned transaction.'}</h3><p>{operation.transaction.operation}: {operation.transaction.ensName}</p><p>{operation.transaction.warning}</p><p>Maximum fee: {Number(operation.maxFeeWei) / 1e18} test ETH.</p><dl><dt>Signer</dt><dd className="mono">{operation.transaction.from}</dd><dt>Contract</dt><dd className="mono">{operation.transaction.to}</dd><dt>Review expires</dt><dd>{new Date(operation.expiresAt).toLocaleString()}</dd></dl><details><summary>Exact calldata</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{operation.transaction.data}</pre></details>
      {!operation.submittedHash && <><label className="check-row"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I reviewed the recipient, public name, retained powers and exact Sepolia transaction.</label><button className="button" disabled={busy || !reviewed} onClick={() => void run(send)}>Review and sign in MetaMask</button></>}
      <label>Submitted transaction hash<input value={hash} onChange={event => setHash(event.target.value)} placeholder="0x..." /></label><button className="button secondary" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(hash)} onClick={() => void run(async () => { await api('namespace/confirm', { operationId: operation.operationId, hash }); await load(); onUpdated?.(); setNotice('Receipt and current chain state confirmed. Continue the next setup step if required.'); })}>Verify receipt and read back</button>
      {!operation.submittedHash && <button className="button secondary" disabled={busy} onClick={() => void run(async () => { await api(`operations/${operation.operationId}/cancel`, { confirmation: 'NOT_SUBMITTED' }); await load(); })}>Cancel only if never submitted</button>}
    </div>}
  </section>;
}
