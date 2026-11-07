'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, MessageCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, Button, Checkline, Field, Tag, type Shared } from './workspace-features';
import styles from './context-library.module.css';

type Citation = { reference: string; quote: string };
type Qualification = {
  id: string; version: number; state: string; stopReason?: string; otherEns: string; summary: string;
  messages: { id: string; speaker: string; content: string; createdAt: string; round: number; evidence: Citation[] }[];
  questions: { id: string; question: string; answered: boolean }[];
  proposalId?: string | null; failureCode?: string | null;
  canRetry?: boolean; attemptsUsed?: number; maxAttempts?: number;
};
type AnswerDraft = { text: string; fieldClass: '' | 'seeking' | 'offering' | 'bio'; providerConsent: boolean; counterpartConsent: boolean };
const emptyAnswer = (): AnswerDraft => ({ text: '', fieldClass: '', providerConsent: false, counterpartConsent: false });
const stateNames: Record<string, string> = {
  queued: 'Waiting for agent review', running: 'Agents are reviewing', needs_owner: 'Your input is needed',
  qualified: 'Agent review complete', not_aligned: 'The agents found a mismatch', round_limit: 'Review limit reached',
  cancelled: 'Cancelled', failed: 'Review stopped', blocked: 'Review blocked', proposed: 'Ready for your decision',
};

export function QualificationPanel(props: Shared) {
  return <OwnerQualificationPanel key={props.state.user.id} {...props} />;
}

function OwnerQualificationPanel({ state, run, busy }: Shared) {
  const [items, setItems] = useState<Qualification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const alive = useRef(true), actionPending = useRef(false), epoch = useRef(0);

  useEffect(() => {
    alive.current = true;
    const refresh = async () => {
      if (actionPending.current || document.visibilityState !== 'visible') return;
      const request = ++epoch.current;
      try {
        const result = await api<Qualification[]>('qualifications');
        if (alive.current && request === epoch.current) { setItems(result); setError(''); }
      } catch (cause) {
        if (alive.current && request === epoch.current) setError(cause instanceof Error ? cause.message : 'Agent conversations could not be loaded.');
      } finally { if (alive.current && request === epoch.current) setLoading(false); }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15000);
    window.addEventListener('focus', refresh);
    return () => { alive.current = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);

  async function refresh() {
    const request = ++epoch.current;
    const result = await api<Qualification[]>('qualifications');
    if (alive.current && request === epoch.current) { setItems(result); setLoading(false); }
  }

  async function perform(task: () => Promise<unknown>, notice?: string) {
    if (busy || actionPending.current) return;
    actionPending.current = true; epoch.current++; setPending(true); setError('');
    try {
      await run(async () => {
        try { await task(); await refresh(); }
        catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'This agent action could not be completed.'); throw cause; }
      }, notice);
    } finally { actionPending.current = false; if (alive.current) setPending(false); }
  }

  function update(id: string, patch: Partial<AnswerDraft>) {
    setDrafts(current => ({ ...current, [id]: { ...(current[id] || emptyAnswer()), ...patch } }));
  }

  return <section className="panel form-panel" aria-label="Live agent qualification">
    <div className="panel-title"><h2>Before an introduction</h2><Button kind="secondary" disabled={busy || pending} onClick={() => void perform(refresh)}><RefreshCw size={15} />Refresh conversations</Button></div>
    <p>Your agents ask focused questions and review the context both people have permitted. A completed review still needs separate human decisions.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {loading ? <p role="status">Loading your agent conversations...</p> : !items.length ? <div className={styles.empty}><MessageCircle size={23} /><p>No qualification conversations yet. Explore a live candidate to start one.</p><Link href="/discover" className="text-link">Find a connection<ArrowUpRight size={14} /></Link></div> : <div className={styles.documents}>
      {items.map(item => {
        const unanswered = item.questions.filter(question => !question.answered);
        const finished = !item.canRetry && ['qualified', 'not_aligned', 'round_limit', 'cancelled', 'failed', 'blocked', 'proposed'].includes(item.state);
        return <article key={item.id} className={styles.document}>
          <header><div><h3>{item.otherEns}</h3><small>Conversation revision {item.version}</small></div><Tag good={Boolean(item.proposalId)}>{stateNames[item.state] || item.state.replaceAll('_', ' ')}</Tag></header>
          <p>{item.summary}</p>
          {item.stopReason && <p className="small-copy">Review outcome: {item.stopReason.replaceAll('_', ' ')}.</p>}
          {item.failureCode && <p role="status" className={styles.notice}>The review stopped ({item.failureCode}). No replacement decision has been assumed.</p>}
          {item.canRetry && <p className="small-copy">You can explicitly retry the unfinished turn after permissions are checked again. Failed requests count toward the limit. {item.attemptsUsed || 0} of {item.maxAttempts || 6} model requests have been reserved.</p>}
          <div className="thread" aria-label={`Agent conversation with ${item.otherEns}`}>
            {item.messages.length ? item.messages.map(message => <article className="exchange-message" key={message.id}>
              <div><strong>{message.speaker}</strong><small>Round {message.round}</small></div><p>{message.content}</p>
              <small><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></small>
              {message.evidence.length > 0 && <details><summary>Sources used in this message</summary>{message.evidence.map((citation, index) => <div key={index}><p>&ldquo;{citation.quote}&rdquo;</p><small>{citation.reference}</small></div>)}</details>}
            </article>) : <p role="status">No completed model message has been recorded yet.</p>}
          </div>
          {item.questions.length > 0 && <div className={styles.policyHistory}><h3>Questions for you</h3><p className="small-copy">Only questions addressed to your account appear here. Choose what each answer describes and approve sharing it for this conversation.</p>
            {item.questions.map(question => {
              const draft = drafts[question.id] || emptyAnswer();
              return <form key={question.id} onSubmit={event => {
                event.preventDefault();
                if (!draft.text.trim() || !draft.fieldClass || !draft.providerConsent || !draft.counterpartConsent) return;
                void perform(async () => {
                  await api(`qualifications/${item.id}/answer`, { version: item.version, questionId: question.id, text: draft.text.trim(), fieldClass: draft.fieldClass, providerDisclosureConsent: true, shareWithCounterpart: true });
                  if (alive.current) setDrafts(current => { const next = { ...current }; delete next[question.id]; return next; });
                }, 'Your answer was saved with your sharing choices.');
              }}><fieldset className={styles.fieldset} disabled={busy || pending || item.state !== 'needs_owner' || question.answered}>
                {question.answered ? <><p>{question.question}</p><Tag good>Answer recorded</Tag></> : <>
                  <Field label={question.question}><textarea rows={3} maxLength={1200} required value={draft.text} onChange={event => update(question.id, { text: event.target.value, providerConsent: false, counterpartConsent: false })} /></Field>
                  <Field label="This answer describes"><select value={draft.fieldClass} required onChange={event => update(question.id, { fieldClass: event.target.value as AnswerDraft['fieldClass'], providerConsent: false, counterpartConsent: false })}><option value="">Choose the matching profile permission</option><option value="seeking">What I seek</option><option value="offering">What I offer</option><option value="bio">My professional context</option></select></Field>
                  <Checkline checked={draft.providerConsent} onChange={value => update(question.id, { providerConsent: value })}>I allow the configured model provider to process this answer for this conversation.</Checkline>
                  <Checkline checked={draft.counterpartConsent} onChange={value => update(question.id, { counterpartConsent: value })}>I allow this answer to be shared with this counterpart for this conversation, subject to my current permissions.</Checkline>
                  <Button type="submit" disabled={!draft.text.trim() || !draft.fieldClass || !draft.providerConsent || !draft.counterpartConsent}>Save my answer</Button>
                </>}
              </fieldset></form>;
            })}
          </div>}
          <div className={styles.toolbar}>
            {item.proposalId && state.proposals.some(proposal => proposal.id === item.proposalId) && <Link href="/approvals" className="button">Review introduction<ArrowUpRight size={15} /></Link>}
            {item.state === 'needs_owner' && <Button disabled={busy || pending || unanswered.length > 0} onClick={() => void perform(() => api(`qualifications/${item.id}/resume`, { version: item.version }))}>Check answers and continue</Button>}
            {item.canRetry && <Button disabled={busy || pending} onClick={() => void perform(() => api(`qualifications/${item.id}/retry`, { version: item.version }))}>Retry unfinished review</Button>}
            {!finished && <Button kind="secondary" disabled={busy || pending} onClick={() => void perform(() => api(`qualifications/${item.id}/cancel`, { version: item.version }), 'This agent conversation has been cancelled.')}>Cancel this conversation</Button>}
          </div>
        </article>;
      })}
    </div>}
    <p className="small-copy"><ShieldCheck size={14} /> Source citations show supplied context. They do not verify professional claims or replace current permissions.</p>
  </section>;
}
