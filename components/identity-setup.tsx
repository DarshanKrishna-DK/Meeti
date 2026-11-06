'use client';
import { useCallback, useEffect, useState } from 'react';
import type { AppState } from '@/packages/shared/src';
import { findMetaMask } from './metamask';
import { api } from './workspace-features';

type Prepared = { operationId: string; expiresAt: string; maxFeeWei: string; submittedHash?: string; transaction: { from: string; to: string; data: string; value: string; gas: string; gasPrice: string; chainId: number; warning?: string }; };
type IdentityState = { identity?: { chainId: number; registry: string; agentId: string }; association: { verified: boolean; reason?: string }; deployment: { verified: boolean; reason?: string }; canPublishEndpoint: boolean; receipts: { operation: string; hash: string; blockNumber: string }[] };
/** Optional owner-managed identity standards. ENS policy remains the separate permission authority. */
export function IdentitySetup({ state, onUpdated }: { state: AppState; onUpdated?: () => void }) {
  return <IdentitySetupForOwner key={state.user.id} state={state} onUpdated={onUpdated} />;
}
function IdentitySetupForOwner({ state, onUpdated }: { state: AppState; onUpdated?: () => void }) {
  const [value, setValue] = useState<IdentityState | null>(null), [prepared, setPrepared] = useState<Prepared | null>(null);
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [approved, setApproved] = useState(false);
  const [hash, setHash] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const next = await api<IdentityState>('identity'); setValue(next);
    const operations = await api<{ id: string; kind: string; data: Omit<Prepared, 'operationId'> }[]>('operations');
    const pending = operations.find(operation => operation.kind === 'identity');
    setPrepared(pending ? { ...pending.data, operationId: pending.id } : null);
    setHash(pending?.data.submittedHash || '');
  }, []);
  useEffect(() => { let active = true; void Promise.resolve().then(() => { if (active) return refresh(); }).catch(failure => { if (active) setError(failure.message); }); return () => { active = false; }; }, [refresh]);
  async function run(work: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Identity request failed. Retry when the connection is available.'); } finally { setBusy(false); } }
  function prepare(operation: string) { void run(async () => { setPrepared(await api<Prepared>('identity/prepare', { operation, maxFeeWei: '500000000000000', ...(operation.startsWith('publish-') ? { name, description, publicApproved: approved } : {}) })); setApproved(false); }); }
  async function submit() {
    if (!prepared || !approved || prepared.submittedHash || Date.parse(prepared.expiresAt) <= Date.now()) throw new Error('Review a current unsigned transaction first.');
    const wallet = await findMetaMask();
    const accounts = await wallet.request({ method: 'eth_accounts' }) as string[];
    if (!accounts.some(account => account.toLowerCase() === prepared.transaction.from.toLowerCase())) throw new Error('Select the authenticated owner in MetaMask first.');
    const chain = await wallet.request({ method: 'eth_chainId' });
    if (BigInt(String(chain)) !== 11155111n) throw new Error('Switch MetaMask to Sepolia before approving this transaction.');
    const { from, to, data, gas, gasPrice } = prepared.transaction;
    if (BigInt(gas) * BigInt(gasPrice) > BigInt(prepared.maxFeeWei)) throw new Error('The transaction exceeds the reviewed fee cap.');
    const submittedHash = String(await wallet.request({ method: 'eth_sendTransaction', params: [{ from, to, data, value: '0x0', gas, gasPrice }] }));
    setHash(submittedHash); setPrepared({ ...prepared, submittedHash });
    await api('identity/submitted', { operationId: prepared.operationId, hash: submittedHash });
  }
  if (!state.agent) return null;
  return <section className="panel stack"><div><p className="eyebrow">Portable agent identity</p><span className="tag">Sepolia testnet demo</span><h2>Publish a public agent card.</h2><p>ENS controls your permissions. The optional registry association lets another client check that your agent name and registration agree. It does not verify professional claims or human identity.</p></div>
    {error && <p role="alert" className="error">{error}</p>}
    <p>{value?.association.verified ? 'Current ENS and registry association verified.' : value?.identity ? 'Registration confirmed. Its public metadata and ENS attestation still need verification.' : 'No confirmed registry identity is stored for this account.'}</p>
    {value?.identity && <p className="mono">Chain {value.identity.chainId} / {value.identity.registry} / Agent {value.identity.agentId}</p>}
    <button className="button secondary" disabled={busy} onClick={() => void run(refresh)}>Refresh current identity</button>
    {!prepared && <><label>Public agent name<input maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label><label>Approved public description<textarea maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} /></label>
      <label className="check-row"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />I approve this description becoming public on Sepolia. It contains no private contacts or files.</label>
      {!value?.canPublishEndpoint && <p>Public endpoint publication requires a configured HTTPS deployment. Local development is not advertised as an external service.</p>}
      <div className="button-row"><button className="button secondary" disabled={busy || Boolean(value?.identity) || !value?.deployment.verified} onClick={() => prepare('register-identity')}>Review registry registration</button>
        <button className="button secondary" disabled={busy || !approved || !name.trim() || !description.trim()} onClick={() => prepare('publish-context')}>Review public context</button>
        <button className="button secondary" disabled={busy || !value?.canPublishEndpoint || !approved || !name.trim() || !description.trim()} onClick={() => prepare('publish-endpoint')}>Review discovery endpoint</button>
        <button className="button secondary" disabled={busy || !value?.identity} onClick={() => prepare('set-identity-uri')}>Review registration metadata</button>
        <button className="button secondary" disabled={busy || !value?.identity} onClick={() => prepare('attest-association')}>Review ENS association</button></div></>}
    {prepared && <div className="stack"><h3>{prepared.submittedHash ? 'Submitted. Confirmation pending.' : 'Review this unsigned Sepolia transaction.'}</h3><p>Maximum fee: {Number(prepared.maxFeeWei) / 1e18} test ETH. The owner signs in MetaMask. No registration fee or real-money sponsorship is implied.</p><dl><dt>From</dt><dd className="mono">{prepared.transaction.from}</dd><dt>Contract</dt><dd className="mono">{prepared.transaction.to}</dd><dt>Expires</dt><dd>{new Date(prepared.expiresAt).toLocaleString()}</dd></dl><details><summary>Exact public transaction data</summary><pre style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{prepared.transaction.data}</pre></details>
      {!prepared.submittedHash && <><label className="check-row"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />I reviewed this exact transaction and its public data.</label><button className="button" disabled={busy || !approved} onClick={() => void run(submit)}>Review and sign in MetaMask</button></>}
      <label>Submitted transaction hash<input value={hash} onChange={event => setHash(event.target.value)} placeholder="0x..." /></label><button className="button secondary" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(hash)} onClick={() => void run(async () => { await api('identity/confirm', { operationId: prepared.operationId, hash }); await refresh(); onUpdated?.(); })}>Check confirmed receipt</button>
      {!prepared.submittedHash && <button className="button secondary" disabled={busy} onClick={() => void run(async () => { await api(`operations/${prepared.operationId}/cancel`, { confirmation: 'NOT_SUBMITTED' }); await refresh(); })}>Cancel only if never submitted</button>}</div>}
    {Boolean(value?.receipts.length) && <details><summary>Confirmed identity transactions</summary>{value!.receipts.map(receipt => <p key={receipt.hash}><a target="_blank" rel="noreferrer" href={`https://sepolia.etherscan.io/tx/${receipt.hash}`}>{receipt.operation}, block {receipt.blockNumber}</a></p>)}</details>}
  </section>;
}
