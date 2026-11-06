'use client';

import { useEffect, useRef, useState } from 'react';
import { FileText, RefreshCw, Sparkles } from 'lucide-react';
import type { Profile } from '@/packages/shared/src';
import type { ProfileIntakeResult } from '@/packages/agents/src';
import { api, Button, Checkline, Field, Tag, type Shared } from './workspace-features';
import styles from './context-library.module.css';

type Intake = { id: string; version: number; text: string; includePrivateContext?: boolean; result: ProfileIntakeResult | null; status: 'running' | 'ready' | 'failed'; failureCode?: string };
type Props = Shared & { onApply: (suggestions: Partial<Profile>) => void; draftConflict: boolean };
type SuggestedField = 'bio' | 'offering' | 'seeking' | 'tags';
const names: Record<SuggestedField, string> = { bio: 'Your story', offering: 'What you offer', seeking: 'What you seek', tags: 'Topics, separated by commas' };

export function ProfileIntake(props: Props) {
  return <OwnerProfileIntake key={props.state.user.id} {...props} />;
}

function OwnerProfileIntake({ state, run, busy, onApply, draftConflict }: Props) {
  const [items, setItems] = useState<Intake[]>([]), [chosen, setChosen] = useState(''), [text, setText] = useState(''), [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [includePrivateContext, setIncludePrivateContext] = useState(false);
  const alive = useRef(true), actionPending = useRef(false), epoch = useRef(0);
  const selected = items.find(item => item.id === chosen) || items[0];

  useEffect(() => {
    alive.current = true;
    const request = ++epoch.current;
    void api<Intake[]>('profile/intakes').then(result => { if (alive.current && request === epoch.current) setItems(result); })
      .catch(cause => { if (alive.current && request === epoch.current) setError(cause instanceof Error ? cause.message : 'Private intake drafts could not be loaded.'); })
      .finally(() => { if (alive.current && request === epoch.current) setLoading(false); });
    return () => { alive.current = false; };
  }, []);

  async function refresh() {
    const request = ++epoch.current, result = await api<Intake[]>('profile/intakes');
    if (alive.current && request === epoch.current) { setItems(result); setLoading(false); }
  }
  async function perform(task: () => Promise<unknown>, notice?: string) {
    if (busy || actionPending.current) return;
    actionPending.current = true; epoch.current++; setPending(true); setError('');
    try { await run(async () => { try { await task(); await refresh(); } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'This profile intake action could not be completed.'); throw cause; } }, notice); }
    finally { actionPending.current = false; if (alive.current) setPending(false); }
  }

  return <section className={`panel form-panel ${styles.library}`} aria-label="Private profile intake">
    <div className="panel-title"><h2><Sparkles size={19} /> Put your context into words</h2><Button kind="secondary" disabled={busy || pending} onClick={() => void perform(refresh)}><RefreshCw size={14} />Refresh drafts</Button></div>
    <p>Describe what you do, what you offer, and who you would like to meet. Your agent can ask a few focused questions and suggest a private profile draft for your review.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <form onSubmit={event => { event.preventDefault(); if (!consent || !text.trim()) return; void perform(async () => {
      const result = await api<{ id?: string }>('profile/intake', { text: text.trim(), providerDisclosureConsent: true, includePrivateContext: includePrivateContext && state.profile.aiConsent });
      if (alive.current) { if (result?.id) setChosen(result.id); setConsent(false); setIncludePrivateContext(false); }
    }, 'Your private intake draft is ready to review.'); }}>
      <fieldset className={styles.fieldset} disabled={busy || pending}>
        <Field label="Your professional context" hint="Share only information you want the configured model provider to process. Up to 8000 characters."><textarea rows={5} maxLength={8000} required value={text} onChange={event => { setText(event.target.value); setConsent(false); }} placeholder="I work on... I can help with... I am looking for..." /></Field>
        <fieldset className={styles.fieldset} disabled={!state.profile.aiConsent}><Checkline checked={includePrivateContext && state.profile.aiConsent} onChange={value => { setIncludePrivateContext(value); setConsent(false); }}>Also send my saved professional details and owner-reviewed, agent-enabled document excerpts to the model provider for this private intake.</Checkline></fieldset>
        <p className="small-copy">This choice uses saved context, not unsaved profile edits. It excludes contact, employer, raw files and extracted previews. It sends nothing to another person and changes no counterpart sharing rule. Private and ask-first scope can be used for your own intake with this separate approval. The combined source and answers must fit within 8000 characters. {!state.profile.aiConsent && 'Save AI processing consent in Your privacy to enable saved context.'}</p>
        <Checkline checked={consent} onChange={setConsent}>I allow this text{includePrivateContext && state.profile.aiConsent ? ' and the selected saved context' : ''} to be processed by the configured model provider to prepare a private draft.</Checkline>
        <Button type="submit" disabled={!consent || !text.trim()}>{pending ? 'Preparing your draft...' : 'Prepare a private draft'}</Button>
      </fieldset>
    </form>
    {loading ? <p role="status">Loading your saved private drafts...</p> : items.length > 0 ? <>
      <Field label="Saved private intake"><select value={selected?.id || ''} disabled={busy || pending} onChange={event => setChosen(event.target.value)}>{items.map((item, index) => <option key={item.id} value={item.id}>Draft {items.length - index}, revision {item.version}: {item.text.slice(0, 65)}</option>)}</select></Field>
      {selected?.includePrivateContext && <p className="small-copy">This intake includes approved saved context. Follow-ups reuse that original source with your new approved answers. Changed professional details, revoked AI consent or changed excerpt approvals require a fresh intake.</p>}
      {selected?.status === 'running' && <p role="status" className={styles.notice}>This private intake is still processing. Refresh its status before sending another answer.</p>}
      {selected?.status === 'failed' && <p role="status" className={styles.notice}>The last intake request stopped{selected.failureCode ? ` (${selected.failureCode})` : ''}. No replacement draft was assumed. {selected.result ? 'Your last completed draft remains available to review.' : 'Start a new intake when you are ready.'}</p>}
      {selected?.result && <IntakeReview key={`${selected.id}:${selected.version}`} entry={{ ...selected, result: selected.result }} busy={busy || pending || selected.status === 'running'} draftConflict={draftConflict} onApply={onApply} onContinue={answers => perform(() => api('profile/intake', { id: selected.id, version: selected.version, answers }), 'Your follow-up answers were processed. Review the updated private draft.')} />}
    </> : <p className={styles.empty}><FileText size={16} /> No private intake draft has been created yet.</p>}
  </section>;
}

function IntakeReview({ entry, busy, draftConflict, onApply, onContinue }: {
  entry: Intake & { result: ProfileIntakeResult }; busy: boolean; draftConflict: boolean; onApply: (suggestions: Partial<Profile>) => void;
  onContinue: (answers: { questionId: string; text: string; providerDisclosureConsent: true }[]) => Promise<void>;
}) {
  const result = entry.result;
  const [answers, setAnswers] = useState<Record<string, { text: string; consent: boolean }>>({});
  const [values, setValues] = useState<Record<SuggestedField, string>>({
    bio: result.draft.about?.value || result.draft.summary || '',
    offering: result.draft.offering.map(fact => fact.value).join('\n'), seeking: result.draft.seeking.map(fact => fact.value).join('\n'),
    tags: result.draft.tags.map(fact => fact.value).join(', '),
  });
  const [selectedFields, setSelectedFields] = useState<SuggestedField[]>([]), [error, setError] = useState(''), [applied, setApplied] = useState(false);
  const unanswered = result.questions.filter(question => !result.answers.some(answer => answer.questionId === question.id));
  const completeAnswers = unanswered.filter(question => answers[question.id]?.text.trim() && answers[question.id]?.consent);
  function apply() {
    setError('');
    const suggestions: Partial<Profile> = {};
    for (const field of selectedFields) {
      if (field === 'tags') {
        const tags = [...new Set(values.tags.split(',').map(value => value.trim()).filter(Boolean))];
        if (tags.length > 12 || tags.some(value => value.length > 50)) { setError('Choose at most 12 topics, each under 51 characters, before adding them to your profile draft.'); return; }
        suggestions.tags = tags;
      } else {
        if (values[field].length > 1500) { setError(`Shorten ${names[field].toLowerCase()} to 1500 characters before adding it to your profile draft.`); return; }
        suggestions[field] = values[field];
      }
    }
    if (selectedFields.length && !draftConflict) { onApply(suggestions); setApplied(true); }
  }
  return <div className={styles.document}>
    <header><h3>Review your private draft</h3><Tag>{result.state.replaceAll('_', ' ')}</Tag></header>
    <small>Round {result.round} of {result.maxRounds}. Updated {new Date(result.updatedAt).toLocaleString()}.</small>
    {result.draft.summary && <p>{result.draft.summary}</p>}
    {result.state === 'round_limit' && <p role="status" className={styles.notice}>This intake reached its question limit. You can review the draft and edit your profile yourself, or start a new intake with clearer context.</p>}
    {result.state === 'needs_owner' && unanswered.length > 0 && <form onSubmit={event => {
      event.preventDefault();
      if (!completeAnswers.length) return;
      void onContinue(completeAnswers.map(question => ({ questionId: question.id, text: answers[question.id].text.trim(), providerDisclosureConsent: true })));
    }}><fieldset className={styles.fieldset} disabled={busy}>
      <h3>A little more context</h3>
      {unanswered.map(question => { const answer = answers[question.id] || { text: '', consent: false }; return <div key={question.id} className={styles.policyHistory}>
        <Field label={question.question}><textarea rows={3} maxLength={3000} value={answer.text} onChange={event => setAnswers(current => ({ ...current, [question.id]: { text: event.target.value, consent: false } }))} /></Field>
        <Checkline checked={answer.consent} onChange={consent => setAnswers(current => ({ ...current, [question.id]: { ...answer, consent } }))}>I allow the configured model provider to process this answer for my private intake.</Checkline>
      </div>; })}
      <Button type="submit" disabled={!completeAnswers.length}>Continue with my approved answers</Button>
    </fieldset></form>}
    <div className={styles.policyHistory}><h3>Choose suggestions for your profile</h3><p className="small-copy">Review and edit each suggestion. Only the fields you select will replace fields in your unsaved private profile draft.</p>
      {(['bio', 'offering', 'seeking', 'tags'] as const).map(field => <div key={field}>
        <Field label={names[field]}><textarea rows={field === 'tags' ? 2 : 3} value={values[field]} disabled={busy} onChange={event => { setApplied(false); setValues(current => ({ ...current, [field]: event.target.value })); }} /></Field>
        <Checkline checked={selectedFields.includes(field)} onChange={checked => { setApplied(false); setSelectedFields(current => checked ? [...current, field] : current.filter(value => value !== field)); }}>Use this suggestion for {names[field].toLowerCase()}</Checkline>
      </div>)}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {draftConflict && <p role="status" className={styles.notice}>Resolve the saved profile changes from your other session before applying these suggestions.</p>}
      <Button kind="secondary" disabled={busy || draftConflict || !selectedFields.length} onClick={apply}>Add selected suggestions to my draft</Button>
      {applied && <p role="status">Your selected suggestions are in the unsaved profile draft above. Review it and choose Save private profile when you are ready.</p>}
    </div>
    <details><summary>Review the supplied sources</summary><p className={styles.extracted}>{entry.text}</p>{result.answers.map(answer => <p key={answer.questionId} className={styles.extracted}>{answer.text}</p>)}<h4>Summary citations</h4>{result.draft.summaryEvidence.map((citation, index) => <p key={index}>&ldquo;{citation.quote}&rdquo; <small>{citation.reference}</small></p>)}{[...(result.draft.about ? [result.draft.about] : []), ...result.draft.offering, ...result.draft.seeking, ...result.draft.tags].map((fact, index) => <p key={index}><strong>{fact.value}</strong><br />&ldquo;{fact.sourceQuote}&rdquo; <small>{fact.sourceReference}</small></p>)}</details>
    <p className="small-copy">This draft has not been saved to your profile or published. Supplied statements and source citations do not verify professional claims.</p>
  </div>;
}
