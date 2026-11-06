'use client';

import { useState } from 'react';
import { Check, ExternalLink, Fingerprint, LockKeyhole, Pause, ShieldCheck, Sparkles } from 'lucide-react';
import type { Action, Agent, Goal } from '@/packages/shared/src';
import { Button, Checkline, Field, Tag, WalletPanel, api, short, submitTransaction, type Shared } from './workspace-features';
import { DraftConflict } from './draft-conflict';

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
};

const purposes: Goal[] = ['cofounder', 'collaborator', 'mentor', 'teammate'];
const purposeLabels: Record<Goal, string> = { cofounder: 'Find a cofounder', collaborator: 'Find a collaborator', mentor: 'Find a mentor', teammate: 'Find a teammate' };
const fieldLabels: Record<string, string> = { displayName: 'Name', headline: 'One-line introduction', bio: 'Story', seeking: 'What I seek', offering: 'What I offer', tags: 'Topics', contact: 'Private contact', employer: 'Private employer' };
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
    fields: agent?.policy.allowedFields || ['headline', 'tags', 'offering'],
    actions: agent?.policy.allowedActions || ['discover', 'evaluate'],
    expiry: localDateTime(agent?.policy.expiresAt || defaultExpiry),
  };
}

export function AgentStudio({ state, run, busy }: Shared) {
  const agent = state.agent;
  const [defaultExpiry] = useState(() => new Date(Date.now() + 7 * 86400000).toISOString());
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
      policy: { purpose: form.purpose, allowedFields: form.fields, allowedActions: form.actions, expiresAt: new Date(form.expiry).toISOString(), paused: agent?.policy.paused || false },
    });
    setDraft(null);
    setBase(null);
    setPrepared(null);
  }

  return <>
    <div className="editor-grid agent-layout">
      <section className="panel form-panel">
        <div className="form-context"><span>Your representative</span><Tag>{draft ? 'Unsaved draft' : agent ? `Policy v${agent.policy.version}` : 'Not configured'}</Tag></div>
        {conflict && <DraftConflict name="agent settings" saved={saved} onUseSaved={() => { setDraft(null); setBase(null); setPrepared(null); }} onKeepDraft={() => setBase(fingerprint)} />}
        <form onSubmit={event => { event.preventDefault(); void run(save, 'Agent and policy saved. Verify live ENS authority before use.'); }}>
          <h2>Give your agent a clear identity.</h2>
          <p>A public name, a purpose and a limited set of permissions. Private memories stay outside ENS.</p>
          <Field label="Agent ENS name"><input required value={form.ensName} onChange={event => update('ensName', event.target.value)} placeholder="agent.yourname.eth" autoCapitalize="none" spellCheck={false} /></Field>
          <Field label="Delegated wallet" hint="The separate wallet permitted to act within this agent scope."><input required value={form.delegate} onChange={event => update('delegate', event.target.value)} placeholder="0x..." autoCapitalize="none" spellCheck={false} /></Field>
          <Field label="Public personality"><textarea rows={3} value={form.persona} onChange={event => update('persona', event.target.value)} placeholder="How should your representative introduce itself?" /></Field>
          <div className="two-fields"><Field label="Policy purpose"><select value={form.purpose} onChange={event => update('purpose', event.target.value as Goal)}>{purposes.map(purpose => <option key={purpose} value={purpose}>{purposeLabels[purpose]}</option>)}</select></Field><Field label="Permission expires"><input required type="datetime-local" value={form.expiry} onChange={event => update('expiry', event.target.value)} /></Field></div>

          <div className="form-section"><div className="form-section-heading"><Sparkles size={20} /><h3>What your agent may do</h3></div><p>These actions remain subject to current ENS authority and the permissions of both people.</p><div className="checkbox-grid">{(Object.keys(actionLabels) as Action[]).map(action => <Checkline key={action} checked={form.actions.includes(action)} onChange={allowed => update('actions', allowed ? [...form.actions, action] : form.actions.filter(value => value !== action))}>{actionLabels[action]}</Checkline>)}</div></div>
          <div className="form-section"><div className="form-section-heading"><LockKeyhole size={20} /><h3>What your agent may share</h3></div><p>Profile visibility and this permission must both allow a field. Contact and employer remain protected.</p><div className="policy-matrix"><div><strong>Profile field</strong><strong>May disclose</strong></div>{Object.entries(fieldLabels).map(([field, label]) => <div key={field}><span>{label}{['contact', 'employer'].includes(field) && <LockKeyhole size={12} />}</span><input aria-label={`Allow ${field} disclosure`} type="checkbox" checked={form.fields.includes(field)} disabled={['contact', 'employer'].includes(field)} onChange={event => update('fields', event.target.checked ? [...form.fields, field] : form.fields.filter(value => value !== field))} /></div>)}</div></div>

          <details><summary>ENS resolver and public policy reference</summary><p className="small-copy">These addresses connect your saved policy to its public permission source.</p><Field label="Resolver address"><input value={form.resolverAddress} onChange={event => update('resolverAddress', event.target.value)} placeholder="0x..." autoCapitalize="none" spellCheck={false} /></Field><Field label="Policy URI" hint="Optional HTTPS reference. Leave blank to embed approved permission classes in ENS."><input value={form.policyUri} onChange={event => update('policyUri', event.target.value)} placeholder="https://..." autoCapitalize="none" spellCheck={false} /></Field></details>
          <div className="form-actions">{draft && <Button kind="secondary" disabled={busy} onClick={() => { setDraft(null); setBase(null); setPrepared(null); }}>Discard draft</Button>}<Button type="submit" disabled={busy || conflict}>Save agent boundaries<Check size={16} /></Button></div>
          <p className="small-copy form-endnote">Changing saved permissions can require a matching ENS policy update. A saved application setting never grants chain authority.</p>
        </form>
      </section>

      <aside className="stack">
        <section className="panel side-panel agent-capability-card"><div className="agent-orb"><Fingerprint size={37} strokeWidth={1.3} /></div><Tag>{draft ? 'Draft public identity' : 'Saved public identity'}</Tag><h2>{form.ensName || 'Your agent, by name.'}</h2><p>{form.persona || 'A representative who knows when to ask and what to keep private.'}</p><dl><dt>Owner wallet</dt><dd>{short(state.user.wallet)}</dd><dt>Last ENS decision</dt><dd>{agent?.authority?.allowed ? 'Allowed' : agent?.authority ? 'Denied' : 'Not checked'}</dd>{agent?.authority?.checkedAt && <><dt>Checked</dt><dd>{new Date(agent.authority.checkedAt).toLocaleString()}</dd></>}</dl>{agent?.authority?.reason && <p className="small-copy">{agent.authority.reason.replaceAll('_', ' ')}</p>}<Button kind="secondary" disabled={busy || !agent} onClick={() => void run(() => api('agent/check', {}), 'Current authority checked.')}><ShieldCheck size={16} />Verify live authority</Button></section>
        <section className="agent-pause-note"><Pause size={24} /><h3>Keep an easy pause within reach.</h3><p>Pausing stops new agent activity. Revocation removes the delegated permission at its source.</p><Button kind="secondary" disabled={busy || !agent} onClick={() => void run(() => api('agent/pause', { paused: !agent?.policy.paused }), 'Agent activity updated.')}>{agent?.policy.paused ? 'Resume agent' : 'Pause agent'}</Button></section>
      </aside>
    </div>

    <section className="panel form-panel transaction-panel">
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
    </section>
    <WalletPanel state={state} run={run} busy={busy} />
  </>;
}

function ArrowIcon() { return <ExternalLink size={15} />; }
