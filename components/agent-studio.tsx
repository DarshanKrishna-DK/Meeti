'use client';

import Link from 'next/link';

import { useState } from 'react';
import { Check, ExternalLink, Fingerprint, LockKeyhole, Pause, ShieldCheck, Sparkles } from 'lucide-react';
import type { Action, Agent, Goal, Policy } from '@/packages/shared/src';
import type { EnsAuthorityResult } from '@/packages/ens';
import { DEFAULT_POLICY_ACTIONS, DEFAULT_POLICY_DAYS, DEFAULT_POLICY_FIELDS } from '@/packages/shared/src/default-policy';
import { Button, Checkline, Field, Tag, WalletPanel, api, short, submitTransaction, type Shared } from './workspace-features';
import { DraftConflict } from './draft-conflict';
import { IdentitySetup } from './identity-setup';
import { NameClaimPanel } from './namespace-claims';
import styles from './context-library.module.css';

type AgentDraft = {
  ensName: string;
  delegate: string;
  persona: string;
  resolverAddress: string;
  policyUri: string;
  purpose: Goal;
  fields: string[];
  actions: Action[];
  expiry: string;
  paused: boolean;
};

const purposes: Goal[] = ['cofounder', 'collaborator', 'mentor', 'teammate'];
const purposeLabels: Record<Goal, string> = { cofounder: 'Find a cofounder', collaborator: 'Find a collaborator', mentor: 'Find a mentor', teammate: 'Find a teammate' };
const fieldLabels: Record<string, string> = { displayName: 'Name', headline: 'One-line introduction', bio: 'Story', seeking: 'What I seek', offering: 'What I offer', tags: 'Topics', socialLinks: 'Approved social links', documentContext: 'Reviewed document excerpts', profileContext: 'Approved private profile context', contact: 'Private contact', employer: 'Private employer' };
const actionLabels: Record<Action, string> = { discover: 'Discover public intents', publish: 'Publish reviewed intents', evaluate: 'Evaluate compatibility', negotiate: 'Exchange permitted context', introduce: 'Propose introductions', message: 'Send room messages' };
const operations = [
  ['deploy-registry', 'Create agent namespace'],
  ['set-subregistry', 'Attach namespace to its parent'],
  ['create-subname', 'Register agent subname'],
  ['deploy-resolver', 'Create dedicated record resolver'],
  ['set-resolver', 'Attach the record resolver'],
  ['set-policy', 'Publish permission policy'],
  ['grant', 'Grant delegated status permission'],
  ['revoke', 'Revoke delegated status permission'],
  ['update-status', 'Update public agent status'],
] as const;

function localDateTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function savedDraft(agent: Agent | null, defaultExpiry: string): AgentDraft {
  return {
    ensName: agent?.ensName || '',
    delegate: agent?.delegate || '',
    persona: agent?.persona || '',
    resolverAddress: String(agent?.config.resolverAddress || ''),
    policyUri: String(agent?.config.policyUri || ''),
    purpose: agent?.policy.purpose || 'collaborator',
    fields: agent?.policy.allowedFields || [...DEFAULT_POLICY_FIELDS],
    actions: agent?.policy.allowedActions || [...DEFAULT_POLICY_ACTIONS],
    expiry: localDateTime(agent?.policy.expiresAt || defaultExpiry),
    paused: agent?.policy.paused || false,
  };
}

type PolicySnapshot = { ensName: string; delegate: string; persona: string; policy: Policy; createdAt: string };

export function AgentStudio(props: Shared) {
  return <AccountAgentStudio key={props.state.user.id} {...props} />;
}

function OptionalIdentitySetup({ state, run, busy }: Shared) {
  const [open, setOpen] = useState(false);
  return <section className="panel form-panel"><h2>Portable agent identity</h2><p className="small-copy">Inspect the optional public identity registration and supported endpoint records. Opening this panel requests fresh chain information. Each write needs a separate wallet review.</p>{!state.agent && <p className="small-copy">Set up or recover your agent before inspecting its public registration.</p>}<Button kind="secondary" disabled={busy || !state.agent} onClick={() => setOpen(value => !value)}>{open ? 'Close identity setup' : 'Open identity setup'}</Button>{open && state.agent && <IdentitySetup state={state} onUpdated={() => { void run(async () => {}, 'Identity receipt updated.'); }} />}</section>;
}

function OptionalNameClaim({ state, run, busy }: Shared) {
  const [open, setOpen] = useState(false);
  return <section className="panel form-panel"><h2>Request your Meeti name</h2><p className="small-copy">Request an available name under the project testnet parent. The issuer reviews each request. A reservation is not a confirmed registration, and test gas is separate from the registration fee.</p><Button kind="secondary" disabled={busy} onClick={() => setOpen(value => !value)}>{open ? 'Close name request' : 'Open name request'}</Button>{open && <NameClaimPanel state={state} onUpdated={() => { void run(async () => {}, 'Name request updated.'); }} />}</section>;
}

function AccountAgentStudio({ state, run, busy }: Shared) {
  const agent = state.agent;
  const authoritySnapshot = agent?.authority?.evidence as EnsAuthorityResult | null | undefined;
  const [defaultExpiry] = useState(() => new Date(Date.now() + DEFAULT_POLICY_DAYS * 86400000).toISOString());
  const saved = savedDraft(agent, defaultExpiry);
  const fingerprint = JSON.stringify(saved);
  const chainSnapshot = fingerprint + '|' + String(agent?.policy.version || 0);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const form = draft || saved;
  const conflict = draft !== null && base !== fingerprint;
  const [operation, setOperation] = useState('grant');
  const [value, setValue] = useState('');
  const [prepared, setPrepared] = useState<{ operationId: string; transaction: Record<string, unknown>; snapshot: string } | null>(null);
  const [sendAttempted, setSendAttempted] = useState(false);
  const [history, setHistory] = useState<PolicySnapshot[] | null>(null);

  function recommendedDefaults() {
    if (!draft) setBase(fingerprint);
    setDraft({ ...form, fields: [...DEFAULT_POLICY_FIELDS], actions: [...DEFAULT_POLICY_ACTIONS], expiry: localDateTime(new Date(Date.now() + DEFAULT_POLICY_DAYS * 86400000).toISOString()) });
    setPrepared(null);
  }

  function reviewHistoricalPolicy(snapshot: PolicySnapshot) {
    if (!draft) setBase(fingerprint);
    setDraft({ ...form, purpose: snapshot.policy.purpose, fields: [...snapshot.policy.allowedFields], actions: [...snapshot.policy.allowedActions], expiry: localDateTime(snapshot.policy.expiresAt), paused: snapshot.policy.paused });
    setPrepared(null);
  }

  function update<Key extends keyof AgentDraft>(key: Key, next: AgentDraft[Key]) {
    if (!draft) setBase(fingerprint);
    setDraft({ ...form, [key]: next });
    setPrepared(null);
  }

  async function save() {
    if (conflict) throw new Error('Review the agent changes from your other session before saving this draft.');
    await api('agent', {
      ensName: form.ensName,
      delegate: form.delegate,
      persona: form.persona,
      resolverAddress: form.resolverAddress,
      policyUri: form.policyUri,
      policy: { purpose: form.purpose, allowedFields: form.fields, allowedActions: form.actions, expiresAt: new Date(form.expiry).toISOString(), paused: form.paused },
    });
    setDraft(null);
    setBase(null);
    setPrepared(null);
  }

  return <>
    <OptionalNameClaim state={state} run={run} busy={busy} />
    <section className="panel ens-guidance"><span className="section-note">Your identity, with a few clear boundaries</span><h2>Start with a name you control.</h2><p>You can sign in without owning an ENS name. Agent actions need a genuine Sepolia ENS agent identity, a separate delegate and current scoped permissions.</p><ol><li><strong>1. Bring an existing agent</strong>Import a configured identity you own. Meeti checks the owner, dedicated resolver, policy and delegation live.</li><li><strong>2. Or create a testnet identity</strong>Use the official Sepolia ENS app for a parent name. Free testnet names and test gas are separate from paid mainnet registration.</li><li><strong>3. Review each permission</strong>Only the approved fields, actions and expiry apply. Saving a form never grants onchain authority.</li></ol><a className="text-link" href="https://sepolia.app.ens.domains/" target="_blank" rel="noopener noreferrer">Open official Sepolia ENS app<ExternalLink size={14}/></a></section>
    {!agent && <fieldset className={styles.fieldset} disabled={busy}><ExistingIdentity state={state} run={run} busy={busy}/></fieldset>}
    <div className="editor-grid agent-layout">
      <section className="panel form-panel">
        <div className="form-context"><span>Your policy manager</span><Tag>{draft ? 'Unsaved policy draft' : agent ? `Policy v${agent.policy.version}` : 'Recommended starting policy'}</Tag></div>
        {conflict && <fieldset className={styles.fieldset} disabled={busy}><DraftConflict name="agent settings" saved={saved} onUseSaved={() => { setDraft(null); setBase(null); setPrepared(null); }} onKeepDraft={() => setBase(fingerprint)} /></fieldset>}
        <form onSubmit={event => { event.preventDefault(); void run(save, 'Agent and policy saved. Verify live ENS authority before use.'); }}>
          <fieldset className={styles.fieldset} disabled={busy}>
          <h2>Manage what your agent may do.</h2>
          <p>One active purpose, chosen actions, approved fields and an expiry you control. Review the defaults, customize them and save a version before reviewing its ENS publication.</p>
          <div className={styles.policySummary}>
            <div className={styles.policyMeta}><Tag>{agent ? `Saved version ${agent.policy.version}` : 'No saved policy'}</Tag><Tag>{agent?.policy.paused ? 'Saved policy paused' : agent ? 'Saved policy unpaused' : 'Review before first save'}</Tag>{draft && <Tag>Changes pending save</Tag>}</div>
            <p>Recommended defaults allow discovery, reviewed publication, compatibility evaluation, permitted exchange, introduction proposals and protected room messages for {DEFAULT_POLICY_DAYS} days. Messages still require both decisions, current permissions and World approval. Headline, topics, offer and request fields are allowed; social links and document excerpts start off.</p>
            <p>Profile approval and AI consent still apply. Saving changes creates a new policy version. Its matching policy digest must be published to ENS before those permissions can become effective. Existing proposals can require a new review.</p>
            <Button kind="secondary" onClick={recommendedDefaults}>Reset draft to recommended defaults</Button>
            <small>This changes this draft only. It preserves the chosen purpose, identity and pause setting. Imported policies are retained until you explicitly save a change.</small>
          </div>
          <details open={!agent}><summary>Agent identity and ENS configuration</summary>
          <p className="small-copy">A public name and personality represent your agent. Private memories stay outside ENS.</p>
          <Field label="Agent ENS name"><input required value={form.ensName} onChange={event => update('ensName', event.target.value)} placeholder="agent.yourname.eth" autoCapitalize="none" spellCheck={false} /></Field>
          <Field label="Delegated wallet" hint="The separate wallet permitted to act within this agent scope."><input required value={form.delegate} onChange={event => update('delegate', event.target.value)} placeholder="0x..." autoCapitalize="none" spellCheck={false} /></Field>
          <Field label="Public personality"><textarea rows={3} value={form.persona} onChange={event => update('persona', event.target.value)} placeholder="How should your representative introduce itself?" /></Field>
          <Field label="Resolver address"><input value={form.resolverAddress} onChange={event => update('resolverAddress', event.target.value)} placeholder="0x..." autoCapitalize="none" spellCheck={false} /></Field><Field label="Policy URI" hint="Optional HTTPS reference. Leave blank to embed approved permission classes in ENS."><input value={form.policyUri} onChange={event => update('policyUri', event.target.value)} placeholder="https://..." autoCapitalize="none" spellCheck={false} /></Field>
          </details>
          <div className="two-fields"><Field label="Active policy purpose" hint="This single purpose must match the networking intent. Other purposes need an explicit policy change."><select value={form.purpose} onChange={event => update('purpose', event.target.value as Goal)}>{purposes.map(purpose => <option key={purpose} value={purpose}>{purposeLabels[purpose]}</option>)}</select></Field><Field label="Permission expires" hint="Expiry is checked again for each protected action."><input required type="datetime-local" value={form.expiry} onChange={event => update('expiry', event.target.value)} /></Field></div>
          <Checkline checked={form.paused} onChange={paused => update('paused', paused)}>Keep this policy paused after saving.</Checkline>

          <div className="form-section"><div className="form-section-heading"><Sparkles size={20} /><h3>What your agent may do</h3></div><p>These actions remain subject to current ENS authority and the permissions of both people.</p><div className="checkbox-grid">{(Object.keys(actionLabels) as Action[]).map(action => <Checkline key={action} checked={form.actions.includes(action)} onChange={allowed => update('actions', allowed ? [...form.actions, action] : form.actions.filter(value => value !== action))}>{actionLabels[action]}{action === 'message' && <small className={styles.checkHint}>Only inside an already authorized introduction room.</small>}</Checkline>)}</div></div>
          <div className="form-section"><div className="form-section-heading"><LockKeyhole size={20} /><h3>What your agent may share</h3></div><p>Profile approval and this permission must both allow a field. Private contact and employer are locked. Enabling a field never approves the values on your behalf.</p><div className="policy-matrix"><div><strong>Context field</strong><strong>May disclose</strong></div>{Object.entries(fieldLabels).map(([field, label]) => <div key={field}><span>{label}{['contact', 'employer'].includes(field) && <LockKeyhole size={12} />}</span><input aria-label={`Allow ${field} disclosure`} type="checkbox" checked={form.fields.includes(field)} disabled={['contact', 'employer'].includes(field)} onChange={event => update('fields', event.target.checked ? [...form.fields, field] : form.fields.filter(value => value !== field))} /></div>)}</div><p className="small-copy">Social links need separate approval in your private profile. Document context means only owner reviewed excerpts with per-file approval and AI consent. Original files stay outside model context and require a separate protected room share. <Link className="text-link" href="/profile">Manage private context</Link></p></div>

          <div className="form-actions">{draft && <Button kind="secondary" disabled={busy} onClick={() => { setDraft(null); setBase(null); setPrepared(null); }}>Discard draft</Button>}<Button type="submit" disabled={busy || conflict}>Save policy for ENS review<Check size={16} /></Button></div>
          <p className="small-copy form-endnote">Changing saved permissions can require a matching ENS policy update. A saved application setting never grants chain authority.</p>
          </fieldset>
        </form>
        <details className={styles.policyHistory}><summary>Saved policy version history</summary><p className="small-copy">Load private snapshots to inspect earlier versions. Copying a version changes only your draft. Saving it creates a new version and requires its matching ENS policy.</p><Button kind="secondary" disabled={busy || !agent} onClick={() => void run(async () => setHistory(await api<PolicySnapshot[]>('agent/policies')))}>Load saved policy versions</Button>{history && !history.length && <p>No policy snapshots are available.</p>}{history?.map(snapshot => <article key={`${snapshot.ensName}:${snapshot.policy.version}`}><h4>Version {snapshot.policy.version}: {purposeLabels[snapshot.policy.purpose]}</h4><p>{snapshot.ensName}. Saved {new Date(snapshot.createdAt).toLocaleString()}. Expires {new Date(snapshot.policy.expiresAt).toLocaleString()}. {snapshot.policy.paused ? 'Paused.' : 'Unpaused.'}</p><p>Actions: {snapshot.policy.allowedActions.map(action => actionLabels[action]).join(', ') || 'None'}. Fields: {snapshot.policy.allowedFields.map(field => fieldLabels[field] || field).join(', ') || 'None'}.</p><Button kind="secondary" disabled={busy || !!draft} onClick={() => reviewHistoricalPolicy(snapshot)}>Copy version {snapshot.policy.version} permissions into draft</Button></article>)}</details>
      </section>

      <aside className="stack">
        <section className="panel side-panel agent-capability-card"><div className="agent-orb"><Fingerprint size={37} strokeWidth={1.3} /></div><Tag>{draft ? 'Draft public identity' : 'Saved public identity'}</Tag><h2>{form.ensName || 'Your agent, by name.'}</h2><p>{form.persona || 'A representative who knows when to ask and what to keep private.'}</p><dl><dt>Owner wallet</dt><dd>{short(state.user.wallet)}</dd><dt>Saved policy version</dt><dd>{agent?.policy.version || 'Not saved'}</dd><dt>Last ENS decision</dt><dd>{agent?.authority?.allowed ? 'Allowed' : agent?.authority ? 'Denied' : 'Not checked for this saved policy'}</dd>{agent?.authority?.checkedAt && <><dt>Snapshot checked</dt><dd>{new Date(agent.authority.checkedAt).toLocaleString()}</dd></>}{authoritySnapshot?.publicPolicy && <><dt>ENS policy version read</dt><dd>{authoritySnapshot.publicPolicy.version}</dd></>}</dl>{agent?.authority?.reason && <p className="small-copy">{agent.authority.reason.replaceAll('_', ' ')}</p>}{authoritySnapshot && <details><summary>Last ENS snapshot evidence</summary><dl><dt>Chain</dt><dd>{authoritySnapshot.chainId}</dd><dt>Block</dt><dd>{authoritySnapshot.blockNumber || 'Not returned'}</dd><dt>Policy digest</dt><dd><code>{authoritySnapshot.policyDigest || authoritySnapshot.publicPolicy?.digest || 'Not returned'}</code></dd></dl></details>}<p className="small-copy">This is the last recorded snapshot. Each protected action checks current authority again.</p><Button kind="secondary" disabled={busy || !agent} onClick={() => void run(() => api('agent/check', {}), 'Current authority checked.')}><ShieldCheck size={16} />Verify live authority</Button></section>
        <section className="agent-pause-note"><Pause size={24} /><h3>Keep an easy pause within reach.</h3><p>Pausing stops new agent activity. Pause and resume each create a new version. Resuming requires a matching ENS policy before activity can continue. Revocation removes delegated permission at its source.</p><Button kind="secondary" disabled={busy || !agent || (!!draft && !!agent.policy.paused)} onClick={() => void run(() => api('agent/pause', { paused: !agent?.policy.paused }), 'Agent activity updated. Review the new policy version and its ENS publication.')}>{agent?.policy.paused ? 'Resume agent' : 'Pause agent'}</Button>{draft && <p className="small-copy">An emergency pause preserves your draft and requires you to review the saved change. Save or discard the draft before resuming.</p>}</section>
      </aside>
    </div>

    <OptionalIdentitySetup state={state} run={run} busy={busy} />
    <section className="panel form-panel transaction-panel"><details className="advanced-agent"><summary>Advanced ENS transactions and receipt verification</summary>
      <fieldset className={styles.fieldset} disabled={busy}>
      <div className="panel-title"><div><h2>Manage permission at its source.</h2><p className="small-copy">Actual ENSv2 wallet actions on Sepolia.</p></div><Tag>Wallet approval required</Tag></div>
      <p>Choose an action, inspect its exact transaction and approve it in your wallet. Network fees may apply.</p>
      {draft && <p className="draft-warning" role="status">Save or discard your agent draft before preparing a chain operation. The transaction must use the saved identity and policy.</p>}
      <div className="two-fields"><Field label="Operation"><select value={operation} onChange={event => { setOperation(event.target.value); setPrepared(null); }}>{operations.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><Field label="Value or record input" hint="Used only when the selected action requires a value."><input value={value} onChange={event => { setValue(event.target.value); setPrepared(null); }} placeholder={operation === 'update-status' ? 'A public agent status' : 'As required by this action'} /></Field></div>
      <Button kind="secondary" disabled={busy || !agent || !!draft} onClick={() => void run(async () => {
        const response = await api<{ operationId: string; transaction: Record<string, unknown> }>('agent/transaction', { operation, value, expiresAt: operation === 'create-subname' ? Math.floor(new Date(form.expiry).getTime() / 1000) : undefined });
        setPrepared({ ...response, snapshot: chainSnapshot });
        setSendAttempted(false);
      })}>Prepare transaction<ArrowIcon /></Button>
      {prepared && <div className="transaction-preview"><h3>Review before signing.</h3><p className="small-copy">This review does not submit anything. Check the network, account, destination and fee before continuing.</p>{prepared.snapshot !== chainSnapshot && <p className="draft-warning">Saved agent settings changed after preparation. Review the latest settings before requesting a new transaction.</p>}<details open><summary>Exact transaction details</summary><pre>{JSON.stringify(prepared.transaction, null, 2)}</pre></details><Button disabled={busy || !!draft || sendAttempted || prepared.snapshot !== chainSnapshot} onClick={() => void run(async () => {
        setSendAttempted(true);
        const hash = await submitTransaction(prepared.operationId, (prepared.transaction.request || prepared.transaction) as Record<string, unknown>);
        await api('agent/confirm', { operationId: prepared.operationId, hash });
        setPrepared(null);
      }, 'Transaction submitted for confirmation.')}>Approve in wallet and send<ExternalLink size={15} /></Button>{sendAttempted && <p className="small-copy form-endnote">A wallet request was made. If its result is uncertain, reconcile the existing transaction in Settings before preparing another.</p>}</div>}
      </fieldset>
    </details></section>
    <WalletPanel state={state} run={run} busy={busy} />
  </>;
}

function ArrowIcon() { return <ExternalLink size={15} />; }

type ExistingIdentityPreview={ensName:string;owner:string;delegate:string;policy:Policy;policyDigest:string;resolverAddress:string;checkedAt:string;blockNumber:string|number};
function ExistingIdentity({state,run,busy}:Shared) {
 const [ensName,setName]=useState('');const [delegate,setDelegate]=useState('');const [preview,setPreview]=useState<ExistingIdentityPreview|null>(null);const [approved,setApproved]=useState(false);
 return <section className="panel form-panel existing-identity"><div className="panel-title"><div><h2>Use my existing agent identity</h2><p className="small-copy">Read and import the exact live policy. No registration or chain transaction.</p></div><Tag>Sepolia only</Tag></div><div className="two-fields"><Field label="Existing ENS agent name" hint="The configured agent subname owned by your signed-in wallet."><input value={ensName} onChange={event=>{setName(event.target.value);setPreview(null);setApproved(false);}} placeholder="agent.yourname.eth" autoCapitalize="none" spellCheck={false}/></Field><Field label="Existing delegated wallet" hint="A separate wallet that already has the scoped ENS permission."><input value={delegate} onChange={event=>{setDelegate(event.target.value);setPreview(null);setApproved(false);}} placeholder="0x..." autoCapitalize="none" spellCheck={false}/></Field></div><p className="small-copy">Your owner wallet: <code>{state.user.wallet}</code></p><Button kind="secondary" disabled={busy||!ensName.trim()||!delegate.trim()} onClick={()=>void run(async()=>{setPreview(null);setApproved(false);setPreview(await api<ExistingIdentityPreview>('agent/import/preview',{ensName:ensName.trim(),delegate:delegate.trim()}));})}><Fingerprint size={16}/>Check my existing identity</Button>{preview&&<div className="identity-import-review"><h3>Review the verified policy</h3><dl><dt>Agent</dt><dd>{preview.ensName}</dd><dt>Owner</dt><dd><code>{preview.owner}</code></dd><dt>Delegate</dt><dd><code>{preview.delegate}</code></dd><dt>Purpose</dt><dd>{preview.policy.purpose}</dd><dt>Policy version</dt><dd>{preview.policy.version}</dd><dt>Expires</dt><dd>{new Date(preview.policy.expiresAt).toLocaleString()}</dd><dt>Allowed actions</dt><dd>{preview.policy.allowedActions.join(', ')||'None'}</dd><dt>Allowed fields</dt><dd>{preview.policy.allowedFields.join(', ')||'None'}</dd><dt>Agent paused</dt><dd>{preview.policy.paused?'Yes':'No'}</dd><dt>Read at</dt><dd>{new Date(preview.checkedAt).toLocaleString()}</dd></dl><details><summary>Resolver and policy evidence</summary><p>Resolver <code>{preview.resolverAddress}</code></p><p>Policy digest <code>{preview.policyDigest}</code></p><p>Block <code>{String(preview.blockNumber)}</code></p></details><Checkline checked={approved} onChange={setApproved}>I reviewed this exact policy, scope and expiry and want to use this agent in Meeti.</Checkline><Button disabled={busy||!approved} onClick={()=>void run(()=>api('agent/import',{ensName:preview.ensName,delegate:preview.delegate,reviewedDigest:preview.policyDigest}),'Existing ENS identity imported after a fresh authority check.')}><Check size={16}/>Import reviewed ENS identity</Button></div>}</section>;
}
