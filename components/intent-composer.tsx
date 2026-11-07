'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { ArrowRight, Check, ExternalLink, Globe2, LockKeyhole, PenLine, Wallet, Zap } from 'lucide-react';
import type { Goal, Intent } from '@/packages/shared/src';
import { requirementReviewQuestion, type IntentSemantics } from '@/packages/matching/src/semantics';
import { normalizeTopics } from '@/packages/shared/src/topics';
import { Button, Checkline, Field, Tag, api, renewWalletPermission, submitTransaction, wallet, type Shared } from './workspace-features';
import { DiscoverySchedule } from './discovery-schedule';

type PreparedPublication = { intentId: string; autoQualification?: {approved:true;includeDemo:boolean}; operationId: string; transaction: { request: Record<string, unknown>; expiresAt: string; maximumFeeWei: string } };
const purposes: Goal[] = ['cofounder', 'collaborator', 'mentor', 'teammate'];
function readableDate(value: string) { if (!value || Number.isNaN(Date.parse(value))) return 'Choose an expiry'; return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
function localDateTime(value: string) { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function defaultExpiry() { return localDateTime(new Date(Date.now() + 7 * 86400000).toISOString()); }

export function Intents({ state, run, busy }: Shared) {
  const router=useRouter();
  const [autoQualification,setAutoQualification]=useState(false),[autoIncludeDemo,setAutoIncludeDemo]=useState(false);
  const [text, setText] = useState('');
  const [disclose, setDisclose] = useState(false);
  const [goal, setGoal] = useState<Goal>('collaborator');
  const [summary, setSummary] = useState('');
  const [topics, setTopics] = useState('');
  const [expiry, setExpiry] = useState(defaultExpiry);
  const [approved, setApproved] = useState(false);
  const [demo, setDemo] = useState(false);
  const [semantics, setSemantics] = useState<IntentSemantics | undefined>();
  const [publication, setPublication] = useState<{ intentId: string; signingMessage: string } | null>(null);
  const [transaction, setTransaction] = useState<PreparedPublication | null>(null);
  const [maximumFee, setMaximumFee] = useState('');
  const [receipt, setReceipt] = useState('');
  const [entity, setEntity] = useState('');
  const [sendAttempted, setSendAttempted] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBase, setEditingBase] = useState<number | null>(null);
  const [savedResponse,setSavedResponse]=useState<Intent|null>(null);
  const [saveError,setSaveError]=useState(''),[saveNotice,setSaveNotice]=useState('');
  const saveFeedback=useRef<HTMLDivElement>(null);
  // A confirmed save response can be shown even if refreshing the wider workspace fails.
  const visibleIntents=savedResponse&&!state.intents.some(intent=>intent.id===savedResponse.id&&intent.version>=savedResponse.version)
    ?[savedResponse,...state.intents.filter(intent=>intent.id!==savedResponse.id)]:state.intents;
  const editingCurrent = visibleIntents.find(intent => intent.id === editingId);
  const editingConflict = editingId !== null && editingCurrent?.version !== editingBase;
  const needsClarification = semantics && (semantics.direction === 'unknown' || semantics.category === 'unknown' || semantics.requirements.some(requirement => requirement.strength === 'unknown') || semantics.clarificationQuestions.length > 0);
  const topicCount=normalizeTopics(topics.split(',')).length;
  const savePrerequisites=[...(!state.agent?['Save your agent settings in Agent Studio first. A private draft needs a saved agent; publication separately checks current ENS permissions.']:[]),...(needsClarification?['Resolve unknown requirements and clarification questions in the interpretation.']:[]),...(!approved?['Confirm that you have reviewed this private draft using the checkbox above.']:[]),...(topicCount<1||topicCount>8?['Add between one and eight topics.']:[])];

  function reviewRequirement(index: number, strength: IntentSemantics['requirements'][number]['strength']) {
    setSemantics(current => {
      if (!current) return current;
      const requirement = current.requirements[index];
      const requirements = current.requirements.map((value, position) => position === index ? { ...value, strength } : value);
      const question = requirementReviewQuestion(requirement);
      const questions = current.clarificationQuestions.filter(value => value !== question);
      // Keep a shared review question while another requirement with the same label remains unresolved.
      if (requirements.some(value => value.strength === 'unknown' && requirementReviewQuestion(value) === question) && questions.length < 5) questions.push(question);
      return { ...current, requirements, clarificationQuestions: questions };
    });
    setApproved(false);
  }

  function edit(intent: Intent) {
    setEditingId(intent.id);
    setEditingBase(intent.version);
    setText(intent.summary);
    setSummary(intent.summary);
    setGoal(intent.goal);
    setTopics(intent.tags.join(', '));
    setSemantics(intent.semantics);
    setExpiry(localDateTime(intent.expiresAt));
    setDemo(intent.demoOrigin);
    setApproved(false);
    document.getElementById('intent-composer')?.focus();
  }

  function newIntent() {
    setEditingId(null); setEditingBase(null); setText(''); setSummary(''); setTopics(''); setSemantics(undefined);
    setExpiry(defaultExpiry()); setGoal('collaborator'); setDemo(false); setApproved(false);
  }

  async function interpret(value: string, replaceSummary: boolean) {
    const result = await api<{ output: { goal: Goal; summary: string; tags: string[]; semantics: IntentSemantics } }>('intent/structure', { text: value, providerDisclosureConsent: true });
    setSemantics(result.output.semantics);
    setGoal(result.output.goal);
    if (replaceSummary) setSummary(result.output.summary);
    setTopics(normalizeTopics(result.output.tags).join(', '));
    setApproved(false);
  }

  return <>
    <DiscoverySchedule state={state} run={run} busy={busy} />
    <ol className="intent-workflow" aria-label="Intent publication steps"><li><span>1</span><div><strong>Shape the intention</strong><small>Private text, with your AI consent</small></div></li><li><span>2</span><div><strong>Review what travels</strong><small>Explicit public fields and expiry</small></div></li><li><span>3</span><div><strong>Approve the publication</strong><small>A separate wallet transaction</small></div></li></ol>
    <div className="editor-grid intent-composition">
      <section className="panel form-panel" id="intent-composer" tabIndex={-1}>
        <div className="form-context"><span>{editingId ? 'Revise your intention' : 'Your intent draft'}</span><Tag>{editingId ? 'Review a new revision' : 'Nothing published yet'}</Tag></div>
        {editingId && <div className="draft-warning"><p>Saving changes replaces the current app revision with a private draft and stops it from matching until the new public revision is confirmed. Historic Arkiv records can remain visible.</p><Button kind="secondary" disabled={busy} onClick={newIntent}>Start a new intent instead</Button></div>}
        <h2>Say what you have in mind.</h2>{editingConflict && <div className="draft-warning" role="status"><p>This intent changed in another session. Your draft is retained, but saving is paused until you load and review the latest revision.</p><Button kind="secondary" disabled={busy || !editingCurrent} onClick={() => { if (editingCurrent) edit(editingCurrent); }}>Load latest intent revision</Button></div>}
        <p>Be clear about what you need and what you can offer. Keep contacts and confidential information out of your public summary.</p>
        <Field label="Your intention, in your own words"><textarea rows={4} value={text} onChange={event => setText(event.target.value)} placeholder="I am building an open-source tool and would like help making its developer onboarding clearer." /></Field>
        <Checkline checked={disclose} onChange={setDisclose}>I approve sending this text to the configured model to structure my intent.</Checkline>
        <Button kind="secondary" disabled={busy || !text.trim() || !disclose} onClick={() => void run(() => interpret(text, true), 'Intent structured. Review every public field below.')}><PenLine size={16} />Help shape my intent</Button>

        <form className="intent-review-form" onInvalid={event=>{setSaveError((event.target as HTMLInputElement).validationMessage||'Review the highlighted field before saving.');setSaveNotice('');}} onSubmit={event => { event.preventDefault(); setSaveError('');setSaveNotice('');void run(async () => { try {
          if(!state.agent)throw new Error('Save your agent settings in Agent Studio before saving an intent.');
          if (editingConflict) throw new Error('This intent changed in another session. Load its latest revision before saving.');
          if (!approved || needsClarification) throw new Error('Review these fields, resolve any interpretation questions and approve the fields before saving your private draft.');
          if(topicCount<1||topicCount>8)throw new Error('Add between one and eight topics before saving.');
          const expiryTime=new Date(expiry).getTime();if(!Number.isFinite(expiryTime)||expiryTime<=Date.now()+60000||expiryTime>Date.now()+30*86400000)throw new Error('Choose an expiry more than one minute from now and within the next 30 days.');
          const saved=await api<Intent>('intent', { id: editingId || undefined, expectedVersion: editingId ? editingBase : undefined, goal, summary, tags: normalizeTopics(topics.split(',')), expiresAt: new Date(expiry).toISOString(), draftReviewed: approved, demoOrigin: demo, semantics });
          if(!saved||typeof saved.id!=='string'||!Number.isInteger(saved.version)||saved.status!=='draft')throw new Error('The save response could not be verified. Refresh Your intentions before trying again.');
          newIntent();
          setSavedResponse(saved);setSaveNotice('Your private draft was saved and is listed below. It has not been published.');
          requestAnimationFrame(()=>document.getElementById('saved-intents')?.scrollIntoView({behavior:'smooth',block:'start'}));
        }catch(failure){setSaveError(failure instanceof Error?failure.message:'Your intent could not be saved. Your draft is still here.');requestAnimationFrame(()=>{saveFeedback.current?.focus();saveFeedback.current?.scrollIntoView({behavior:'smooth',block:'center'});});throw failure;}
        }, 'Intent draft saved below. Publication requires a separate wallet approval.'); }}>
          <div className="form-section-heading"><Globe2 size={20} /><h3>Make the public version yours.</h3></div>
          <Field label="I am looking for a"><select value={goal} onChange={event => { setGoal(event.target.value as Goal); setSemantics(undefined); setApproved(false); }}>{purposes.map(purpose => <option key={purpose}>{purpose}</option>)}</select></Field>
          <Field label="Public intent summary"><textarea required minLength={10} maxLength={1000} rows={4} value={summary} onChange={event => { setSummary(event.target.value); setSemantics(undefined); setApproved(false); }} placeholder="The connection you hope to make, without private details." /></Field>
          <Button kind="secondary" disabled={busy || !summary.trim() || !disclose} onClick={() => void run(() => interpret(summary, false), 'Updated intent interpretation. Review direction, requirements and public fields.')}>Interpret the reviewed summary<ArrowRight size={15} /></Button>
          {semantics ? <section className="interpretation-card" aria-label="Review intent interpretation"><div><strong>{semantics.direction.replaceAll('-', ' ')}</strong><Tag>Review before saving</Tag></div><p>Role: {semantics.canonicalRole?.value || 'Not specified'}</p>{semantics.clarificationQuestions.map(question => <p key={question} className="clarification-question">{question}</p>)}{semantics.requirements.length > 0 && <><p>Correct how strongly each requirement matters to you. Mandatory requirements must be met. Preferred requirements are useful but optional. Unknown requirements need clarification.</p>{semantics.requirements.map((requirement, index) => <article key={index} aria-label={`Requirement ${index + 1}`}><p><strong>Requirement {index + 1}:</strong> {requirement.kind}: {requirement.value}</p><Field label={`Strength for requirement ${index + 1}: ${requirement.value}`} hint={`Original source quote: ${requirement.sourceQuote}`}><select disabled={busy} value={requirement.strength} onChange={event => reviewRequirement(index, event.target.value as IntentSemantics['requirements'][number]['strength'])}><option value="mandatory">Mandatory</option><option value="preferred">Preferred</option><option value="unknown">Unknown, needs clarification</option></select></Field></article>)}<p>Changing a strength clears public approval. Saving creates a private draft. Existing public records change only after you separately review and confirm publication.</p></>}{needsClarification && <p role="status">Resolve unknown requirements and clarification questions before saving. Correct requirement strengths here, or edit the summary and interpret it again for other corrections.</p>}<small>Unknown requirements do not establish eligibility. A similar subject alone does not establish mutual fit.</small></section> : <p className="small-copy interpretation-hint">AI interpretation is optional for saving a private draft. Interpret the reviewed summary before publication or matching. Editing the summary requires a new interpretation before publication.</p>}
          <Field label="Topics"><input value={topics} onChange={event => { setTopics(event.target.value); setApproved(false); }} placeholder="Comma-separated tags" /></Field>
          <Field label="Discoverable until" hint="Shown in your device time zone. Expiry stops new matching, not historical copies."><input required type="datetime-local" value={expiry} onChange={event => { setExpiry(event.target.value); setApproved(false); }} /></Field>
          <Checkline checked={approved} onChange={setApproved}>I have reviewed this private draft. Publishing requires a separate public review, signature and transaction.</Checkline>
          {savePrerequisites.length>0&&<div className="small-copy" aria-label="Before this draft can be saved"><strong>Before saving</strong><ul>{savePrerequisites.map(message=><li key={message}>{message}</li>)}</ul>{!state.agent&&<Link className="inline-link" href="/agent">Open Agent Studio</Link>}</div>}
          <div className="form-actions"><Button type="submit" disabled={busy || savePrerequisites.length>0 || editingConflict}>Save private draft<Check size={16} /></Button></div>
          {saveError&&<div ref={saveFeedback} tabIndex={-1} className="alert error" role="alert" data-intent-save-error><div><strong>Your intent was not saved.</strong><p>{saveError}</p><p>Your input is still in this form.</p>{saveError.toLowerCase().includes('pending transaction')&&<Link className="inline-link" href="/settings#pending-wallet-operations">View the pending wallet transaction in Settings</Link>}{!state.agent&&<Link className="inline-link" href="/agent">Set up your agent in Agent Studio</Link>}</div></div>}
          {saveNotice&&<p role="status">{saveNotice}</p>}
        </form>
      </section>

      <aside className="stack intent-preview-column">
        <section className="panel preview-panel"><Tag><Globe2 size={14} /> What others will see</Tag><div className="public-intent">{demo && <Tag>Fictional demonstration</Tag>}<span className="icon-box"><Zap size={23} /></span><h2>{summary || 'A clear reason to connect.'}</h2><div className="tags"><Tag>{goal}</Tag>{normalizeTopics(topics.split(',')).map(topic => <Tag key={topic}>{topic}</Tag>)}</div><dl><dt>Agent</dt><dd>{state.agent?.ensName || 'Set up your ENS agent first'}</dd><dt>Available until</dt><dd>{readableDate(expiry)}</dd></dl></div></section>
        <section className="profile-privacy-note"><LockKeyhole size={23} /><h3>Just the intention you approved.</h3><p>No contacts, no private chats and no verification identifiers travel with this public record.</p><p>Before publication, your wallet signs the exact public fields. Confirming a transaction is a separate action.</p></section>
      </aside>
    </div>

    <section id="saved-intents" className="panel form-panel saved-intents"><div className="panel-title"><div><h2>Your intentions</h2><p className="small-copy">Drafts stay private until a reviewed publication is confirmed.</p></div><Tag>{visibleIntents.length} total</Tag></div>{visibleIntents.length ? visibleIntents.map(intent => <article className="saved-intent" key={intent.id}><div className="saved-intent-heading"><span className="icon-box"><Zap size={19} /></span><div><Tag good={intent.status === 'published'}>{intent.publicStatus === 'closed' && intent.status === 'draft' ? 'Closure awaiting publication' : intent.status}</Tag>{intent.demoOrigin && <Tag>Fictional test data</Tag>}</div></div><h3>{intent.summary}</h3><div className="saved-intent-meta"><span>{intent.semantics?.direction.replaceAll('-', ' ') || intent.goal}</span><span>Revision {intent.version}</span><span>Expires {readableDate(intent.expiresAt)}</span></div>{intent.arkivKey && <div className="public-evidence"><span>Arkiv entity</span><code>{intent.arkivKey}</code>{intent.transactionHash && <a href={`https://rabdi.explorer.arkiv.network/tx/${intent.transactionHash}`} target="_blank" rel="noopener noreferrer">View confirmed transaction<ExternalLink size={13} /></a>}</div>}<div className="saved-intent-actions"><Button kind="secondary" disabled={busy} onClick={() => edit(intent)}>{intent.status === 'expired' ? 'Renew intent draft' : 'Edit intent'}</Button>{intent.status === 'published' && <Button kind="secondary" disabled={busy} onClick={() => void run(() => api('intent/close', { intentId: intent.id }), 'Matching stopped locally. Publish the closure revision to update Arkiv.')}>Close intent</Button>}{intent.status === 'draft' && !intent.semantics && <p className="small-copy">Interpret this draft before publication. Choose Edit intent, then Interpret the reviewed summary.</p>}{intent.status === 'draft' && <Button kind="secondary" disabled={busy || !intent.semantics} onClick={() => void run(async () => { const response = await api<{ signingMessage: string }>('intent/publish', { intentId: intent.id }); setPublication({ intentId: intent.id, signingMessage: response.signingMessage }); setMaximumFee(''); setAutoQualification(false); setAutoIncludeDemo(false); })}>Review publication<ArrowRight size={15} /></Button>}</div></article>) : <div className="empty"><span className="empty-icon"><Zap size={27} /></span><h3>One clear intention can open a door.</h3><p>Save your first reviewed intent above. You can inspect it before any public write.</p></div>}</section>

    {publication && <section className="panel form-panel publication-review"><div className="panel-title"><h2>Approve the exact public message.</h2><Tag>Wallet signature</Tag></div><p>Your signature authorizes these public fields for this intent. The publication transaction is reviewed separately.</p><details open><summary>Read the complete message before signing</summary><pre>{publication.signingMessage}</pre></details><Field label="Maximum fee in wei" hint="An explicit test GLM budget for this publication. One test GLM equals 10¹⁸ wei."><input inputMode="numeric" value={maximumFee} onChange={event => setMaximumFee(event.target.value)} placeholder="Your explicit maximum fee" /></Field><Checkline checked={autoQualification} onChange={setAutoQualification}>After confirmed publication, I approve one search and qualification of up to two eligible counterparts using my approved context and the configured model provider.</Checkline>{autoQualification&&<><p className="small-copy">The reviewed request lasts at most one hour. Keep Agent exchange open to follow progress. Existing provider budgets and permissions apply. No introduction is approved for you, and failed or uncertain work is not retried automatically.</p><Checkline checked={autoIncludeDemo} onChange={setAutoIncludeDemo}>Include clearly labeled fictional demonstration intentions in this search.</Checkline></>}<div className="form-actions"><Button kind="secondary" disabled={busy} onClick={() => setPublication(null)}>Close review</Button><Button disabled={busy || !maximumFee} onClick={() => void run(async () => {
      const provider = wallet();
      const addresses = await provider.request({ method: 'eth_requestAccounts' }) as string[];
      if (!state.user.wallet || addresses[0]?.toLowerCase() !== state.user.wallet.toLowerCase()) throw new Error('Select the wallet linked to this Meeti account before signing.');
      const signature = await provider.request({ method: 'personal_sign', params: [publication.signingMessage, addresses[0]] });
      const response = await api<Omit<PreparedPublication, 'intentId'>>('intent/publish', { intentId: publication.intentId, signature, maxFeeWei: maximumFee });
      setTransaction({ ...response, intentId: publication.intentId, autoQualification:autoQualification?{approved:true,includeDemo:autoIncludeDemo}:undefined }); setReceipt(''); setEntity(''); setSendAttempted(false); setPublication(null);
    })}>Sign publication approval in wallet<Wallet size={16} /></Button></div><div className="connection-renewal"><p className="small-copy">Wallet signing authorization expired after changing networks? Renew this app connection, then review the message again.</p><Button kind="secondary" disabled={busy} onClick={() => void run(() => renewWalletPermission(state.user.wallet), 'Wallet connection refreshed. Review the message before signing.')}><Wallet size={15} />Renew wallet connection</Button></div></section>}

    {transaction && <section className="panel form-panel publication-review"><div className="panel-title"><h2>Review the Arkiv transaction.</h2><Tag>Rabdi testnet</Tag></div><p>Check the prepared network, account, fee and expiry. A missing or uncertain wallet result must be reconciled rather than sent again.</p><details open><summary>Exact transaction details</summary><pre>{JSON.stringify(transaction.transaction, null, 2)}</pre></details><Button disabled={busy || sendAttempted} onClick={() => void run(async () => { setSendAttempted(true); setReceipt(await submitTransaction(transaction.operationId, transaction.transaction.request)); }, 'Transaction sent. Verify its receipt below.')}>Send reviewed transaction in wallet<ExternalLink size={15} /></Button>{sendAttempted && <p className="small-copy interpretation-hint">A wallet request was made for this operation. If the outcome is uncertain, use the <Link className="inline-link" href="/settings">operation journal in Settings</Link> before any new submission.</p>}<div className="receipt-verification"><h3>Verify the actual result.</h3><Field label="Transaction hash"><input value={receipt} onChange={event => setReceipt(event.target.value)} placeholder="0x..." autoCapitalize="none" spellCheck={false} /></Field><Field label="Resulting Arkiv entity key (optional)"><input value={entity} onChange={event => setEntity(event.target.value)} placeholder="0x..." autoCapitalize="none" spellCheck={false} /></Field><Button kind="secondary" disabled={busy || !receipt} onClick={() => void run(async () => { await api('intent/confirm', { intentId: transaction.intentId, operationId: transaction.operationId, entityKey: entity || undefined, txHash: receipt, ...(transaction.autoQualification?{autoQualification:transaction.autoQualification}:{}) }); setTransaction(null); if(transaction.autoQualification)router.push('/activity'); }, 'Publication confirmation checked.')}>Verify publication receipt<Check size={15} /></Button></div></section>}
  </>;
}
