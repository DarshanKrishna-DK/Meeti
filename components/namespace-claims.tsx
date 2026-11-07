'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Clock3, Fingerprint, RefreshCw } from 'lucide-react';
import type { AppState } from '@/packages/shared/src';
import { findMetaMask } from './metamask';
import { api } from './api-client';
import { confirmedName, nameRequestStatus, type NameClaim } from './setup-state';
import styles from './namespace-claims.module.css';

type Operation = { operationId: string; expiresAt: string; maxFeeWei: string; submittedHash?: string; transaction: { from: string; to: string; data: string; gas: string; gasPrice: string; operation: string; ensName: string; warning?: string } };
type Overview = { parent: string; branch: string; issuer: string; isOperator: boolean; claim: NameClaim | null; requests: NameClaim[]; operations: Operation[]; custody: string; sponsorship: string };
type Props = { state: AppState; onUpdated?: () => void; onClaimChanged?: (claim: NameClaim | null) => void; onUseName?: (claim: NameClaim) => void };

export function useNameClaimSummary(userId: string) {
  const [saved, setSaved] = useState<{ userId: string; claim: NameClaim | null } | null>(null);
  useEffect(() => {
    let active = true, loading = false;
    const load = async () => { if (loading || document.hidden) return; loading = true; try { const value = await api<Overview>('namespace/claims'); if (active) setSaved({ userId, claim: value.claim }); } catch { /* Keep only the current owner's last known request. */ } finally { loading = false; } };
    void load(); const timer = setInterval(() => { void load(); }, 30000);
    window.addEventListener('focus', load); document.addEventListener('visibilitychange', load);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', load); };
  }, [userId]);
  return saved?.userId === userId ? saved.claim : null;
}
export function NameClaimPanel(props: Props) { return <OwnerNameClaimPanel key={props.state.user.id} {...props} />; }
function OwnerNameClaimPanel({ state, onUpdated, onClaimChanged, onUseName }: Props) {
  const [overview, setOverview] = useState<Overview | null>(null), [label, setLabel] = useState(''), [consent, setConsent] = useState(false), [editing, setEditing] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null), [reviewed, setReviewed] = useState(false), [hash, setHash] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [setup, setSetup] = useState<unknown>(null);
  const alive = useRef(true), callbacks = useRef({ onClaimChanged, busy });
  useEffect(() => { callbacks.current = { onClaimChanged, busy }; }, [onClaimChanged, busy]);
  const load = useCallback(async () => {
    const result = await api<Overview>('namespace/claims');
    if (!alive.current) return;
    if (result.claim && result.claim.recipient.toLowerCase() !== state.user.wallet?.toLowerCase()) throw new Error('The name request belongs to a different wallet. Sign in again.');
    setOverview(result); setOperation(result.operations[0] || null); setHash(result.operations[0]?.submittedHash || ''); callbacks.current.onClaimChanged?.(result.claim);
  }, [state.user.wallet]);
  useEffect(() => { alive.current = true; void load().catch(failure => { if (alive.current) setError(failure instanceof Error ? failure.message : 'Your name request could not load.'); }); return () => { alive.current = false; }; }, [load]);
  const waiting = Boolean(overview?.claim && ['requested', 'prepared'].includes(overview.claim.state));
  useEffect(() => {
    if (!waiting || overview?.isOperator) return;
    const timer = setInterval(() => { if (!document.hidden && !callbacks.current.busy) void load().catch(() => {}); }, 15000);
    return () => clearInterval(timer);
  }, [waiting, overview?.isOperator, load]);
  async function run(work: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await work(); } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : 'The name request failed. Refresh and retry.'); } finally { if (alive.current) setBusy(false); } }
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
  const claim = overview?.claim, status = nameRequestStatus(claim), registered = confirmedName(claim);
  const showForm = overview && (!claim || claim.state === 'withdrawn' || editing);
  return <section id="name-request" className={`panel ${styles.panel}`} aria-label="Your Meeti name">
    <header className={styles.header}><div><h2>{state.agent && !claim ? 'Your existing agent name.' : status.title}</h2><p>{state.agent && !claim ? 'Your account already has an agent saved. Review its current permissions in Agent Studio, or request a separate personal name below.' : status.description}</p></div><span className={styles.icon}><Fingerprint size={24}/></span></header>
    {!state.agent && <ol className={styles.steps} aria-label="Name registration progress">{['Choose a name', 'Request received', 'Registration confirmed'].map((text, index) => <li key={text} className={index <= status.step ? styles.current : ''} aria-current={index === status.step ? 'step' : undefined}><span>{index < status.step ? <Check size={14}/> : index + 1}</span>{text}</li>)}</ol>}
    {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!overview && !error && <p role="status">Loading your name request...</p>}
    {claim && <div className={styles.name}><span className={styles.status}>{registered ? <Check size={15}/> : <Clock3 size={15}/>} {status.label}</span><strong>{claim.userName}</strong><p>{registered ? 'Agent name to set up' : 'Planned agent name'}: {claim.agentName}</p>
      {registered && <div className={styles.actions}>{onUseName ? <button id="use-confirmed-name" className="button" disabled={busy} onClick={() => onUseName(claim)}>Use this name<ArrowRight size={16}/></button> : <Link className="button" href="/agent#name-request">Continue to agent setup<ArrowRight size={16}/></Link>}<small>Registration does not create or authorize the agent.</small></div>}
      {waiting && <><p className="small-copy">Signed in as <code>{state.user.wallet}</code>. This request belongs to this wallet. If you registered with a different wallet, sign in with that wallet to recover its name.</p><div className={styles.actions}><button className="button secondary" disabled={busy} onClick={() => void run(async () => { await load(); setNotice('Saved registration status refreshed. This check does not send a registration transaction.'); })}><RefreshCw size={15}/>Check registration</button><Link className="text-link" href="/profile">Continue with your profile</Link></div></>}
    </div>}
    {!claim && state.agent && <div className={styles.name}><span className={styles.status}>Saved agent identity</span><strong>{state.agent.ensName}</strong><p>A saved name is not a current permission check.</p><Link className="text-link" href="/agent#agent-profile">Review this agent<ArrowRight size={15}/></Link></div>}
    {showForm && overview && <form className={styles.form} onSubmit={event => { event.preventDefault(); void run(async () => {
      const result = await api<{ availability?: { confirmedAvailable: boolean; reason?: string }; recovered?: boolean }>('namespace/claim', { label, publicNameAndWalletApproved: true });
      await load(); setEditing(false); setNotice(result.recovered ? 'Your existing request was recovered. Registration status is shown above.' : result.availability?.confirmedAvailable ? 'The name is available. Your request is saved and registration is still pending.' : 'Your request is saved. Availability and registration still need confirmation.'); setConsent(false); onUpdated?.();
    }); }}>
      <label>Choose your name<input required maxLength={63} value={label} onChange={event => { setLabel(event.target.value); setConsent(false); }} placeholder="your-name" autoCapitalize="none" spellCheck={false}/></label>
      <div className={styles.preview} aria-label="Name preview">{label.trim().toLowerCase() || 'your-name'}.{overview.branch}</div>
      <p className="small-copy">This name and your wallet address will be public. The project retains control of the parent namespace.</p>
      <label className={styles.consent}><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)}/>I approve this public name and wallet association.</label>
      <div className={styles.actions}><button className="button" disabled={busy || !consent || !label.trim()} type="submit">{busy ? 'Saving request...' : 'Request this name'}<ArrowRight size={16}/></button>{editing && <button className="text-link" type="button" onClick={() => setEditing(false)}>Keep current request</button>}</div>
    </form>}
    {overview && <details className={styles.details}><summary>Registration details and recovery</summary><p>The displayed name uses the actual {overview.branch} namespace on Sepolia. A request is not a registration. Only its confirmed issuance receipt unlocks the next setup step.</p><p>{overview.custody}</p><button className="button secondary" disabled={busy} onClick={() => void run(load)}>Refresh saved request</button>
      {claim?.state === 'requested' && <div className={styles.actions}><button className="text-link" disabled={busy} onClick={() => { setLabel(claim.label); setEditing(true); setConsent(false); }}>Change requested name</button><button className="text-link" disabled={busy} onClick={() => void run(async () => { await api('namespace/withdraw', { version: claim.version }); await load(); onUpdated?.(); })}>Withdraw unsigned request</button></div>}
      <div className={styles.receipts}>{claim?.receipts.map(receipt => <a key={receipt.hash} href={`https://sepolia.etherscan.io/tx/${receipt.hash}`} target="_blank" rel="noreferrer">{receipt.operation === 'issue-project-subname' ? 'Name registration receipt' : 'Namespace setup receipt'}, block {receipt.blockNumber}</a>)}</div>
      {claim?.recipientRegistry && <p>Recipient registry: <code>{claim.recipientRegistry}</code></p>}
    </details>}
    {overview?.isOperator && <details className={styles.details}><summary>Project registration controls</summary><div className="stack"><p>These actions use your issuer wallet. Each transaction needs an explicit review and has a maximum fee of 0.0005 test ETH. The server does not sign.</p><div className={styles.actions}><button className="button secondary" disabled={busy} onClick={() => void run(async () => setSetup(await api('namespace/setup', {})))}>Inspect project control</button><button className="button secondary" disabled={busy || Boolean(operation)} onClick={() => void run(() => prepare('namespace/prepare-branch', {}))}>Review next namespace step</button></div>
      {setup != null && <details><summary>Current chain inspection</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(setup, null, 2)}</pre></details>}
      {overview.requests.filter(item => !['confirmed', 'withdrawn'].includes(item.state)).map(item => <div key={item.id}><h3>{item.userName}</h3><p>Recipient: <code>{item.recipient}</code>. Request version {item.version}. The recipient retains the roles in its dedicated registry.</p><button className="button secondary" disabled={busy || Boolean(operation)} onClick={() => void run(() => prepare('namespace/prepare-claim', { claimId: item.id, version: item.version }))}>Review next registration step</button></div>)}
    </div></details>}
    {operation && <div className={`stack ${styles.transaction}`}><h3>{operation.submittedHash ? 'Transaction sent. Confirmation pending.' : 'Review before wallet approval.'}</h3><p>{operation.transaction.operation}: {operation.transaction.ensName}</p><p>{operation.transaction.warning}</p><p>Maximum fee: {Number(operation.maxFeeWei) / 1e18} test ETH.</p><dl><dt>Signer</dt><dd className="mono">{operation.transaction.from}</dd><dt>Contract</dt><dd className="mono">{operation.transaction.to}</dd><dt>Review expires</dt><dd>{new Date(operation.expiresAt).toLocaleString()}</dd></dl><details><summary>Exact transaction data</summary><pre>{operation.transaction.data}</pre></details>
      {!operation.submittedHash && <><label className={styles.consent}><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/>I reviewed the recipient, public name, retained powers and exact Sepolia transaction.</label><button className="button" disabled={busy || !reviewed} onClick={() => void run(send)}>Review and sign in MetaMask</button></>}
      <label>Submitted transaction hash<input value={hash} onChange={event => setHash(event.target.value)} placeholder="0x..."/></label><button className="button secondary" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(hash)} onClick={() => void run(async () => { await api('namespace/confirm', { operationId: operation.operationId, hash }); await load(); onUpdated?.(); setNotice('Receipt confirmed. Review the actual registration state above before continuing.'); })}>Verify transaction receipt</button>
      {!operation.submittedHash && <button className="text-link" disabled={busy} onClick={() => void run(async () => { await api(`operations/${operation.operationId}/cancel`, { confirmation: 'NOT_SUBMITTED' }); await load(); })}>Cancel only if never submitted</button>}
    </div>}
  </section>;
}
