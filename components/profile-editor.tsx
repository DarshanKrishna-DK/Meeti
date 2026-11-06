'use client';

import { useState } from 'react';
import { ArrowRight, Check, Globe2, LockKeyhole, Users } from 'lucide-react';
import type { Profile } from '@/packages/shared/src';
import { Button, Checkline, Field, Tag, api, type Shared } from './workspace-features';
import { DraftConflict } from './draft-conflict';

const publicFields = ['displayName', 'headline', 'bio', 'seeking', 'offering', 'tags'];
const fieldNames: Record<string, string> = { displayName: 'Name', headline: 'One-line introduction', bio: 'Story', seeking: 'What I seek', offering: 'What I offer', tags: 'Topics' };

export function ProfileEditor({ state, run, busy }: Shared) {
  const [draft, setDraft] = useState<Profile | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const profile = draft || state.profile;
  const savedFingerprint = JSON.stringify(state.profile);
  const conflict = draft !== null && base !== savedFingerprint;

  function update<Key extends keyof Profile>(key: Key, value: Profile[Key]) {
    if (!draft) setBase(savedFingerprint);
    setDraft({ ...profile, [key]: value });
  }

  async function save() {
    if (conflict) throw new Error('Review the profile changes from your other session before saving this draft.');
    await api('profile', profile);
    setDraft(null);
    setBase(null);
  }

  return <div className="editor-grid profile-layout">
    <section className="panel form-panel">
      <div className="form-context"><span>Private profile</span><Tag>{draft ? 'Unsaved draft' : 'Saved account context'}</Tag></div>
      {conflict && <DraftConflict name="profile" saved={state.profile} onUseSaved={() => { setDraft(null); setBase(null); }} onKeepDraft={() => setBase(savedFingerprint)} />}
      <div className="tabs" aria-label="Profile sections">{['About you', 'What connects you', 'Your privacy'].map((label, index) => <button key={label} className={step === index ? 'active' : ''} aria-current={step === index ? 'step' : undefined} onClick={() => setStep(index)}>{index + 1}. {label}</button>)}</div>
      <form onSubmit={event => { event.preventDefault(); if (step < 2) setStep(step + 1); else void run(save, 'Your private profile has been saved.'); }}>
        {step === 0 ? <>
          <h2>First, a little about you.</h2>
          <p>The context your agent starts with. Public visibility is a separate choice.</p>
          <Field label="Your name"><input required value={profile.displayName} onChange={event => update('displayName', event.target.value)} placeholder="What should we call you?" autoComplete="name" maxLength={100} /></Field>
          <Field label="A one-line introduction"><input value={profile.headline} onChange={event => update('headline', event.target.value)} placeholder="What you do, in your own words" maxLength={200} /></Field>
          <Field label="Your story"><textarea rows={5} maxLength={1500} value={profile.bio} onChange={event => update('bio', event.target.value)} placeholder="The things you are working on and care about." /></Field>
        </> : step === 1 ? <>
          <h2>What could you build together?</h2>
          <p>Give your representative context about the connection you want to make.</p>
          <Field label="What you are looking for"><textarea rows={3} maxLength={1500} value={profile.seeking} onChange={event => update('seeking', event.target.value)} placeholder="A collaborator, mentor or your next teammate" /></Field>
          <Field label="What you can offer"><textarea rows={3} maxLength={1500} value={profile.offering} onChange={event => update('offering', event.target.value)} placeholder="Skills, experience or a different perspective" /></Field>
          <Field label="Your topics" hint="Separate topics with commas."><input value={profile.tags.join(', ')} onChange={event => update('tags', event.target.value.split(',').map(value => value.trim()))} placeholder="Design, climate, developer tools" /></Field>
        </> : <>
          <h2>You choose what travels.</h2>
          <p>Only selected fields can appear in your public projection. Contact details and employer stay private.</p>
          <div className="permission-list">{publicFields.map(field => <Checkline key={field} checked={profile.publicFields.includes(field)} onChange={allowed => update('publicFields', allowed ? [...profile.publicFields, field] : profile.publicFields.filter(value => value !== field))}>{fieldNames[field]} may be public</Checkline>)}</div>
          <Field label="Private contact"><input maxLength={300} value={profile.contact} onChange={event => update('contact', event.target.value)} placeholder="Protected until the full approval flow passes" /></Field>
          <Field label="Private employer"><input maxLength={200} value={profile.employer} onChange={event => update('employer', event.target.value)} /></Field>
          <Checkline checked={profile.aiConsent} onChange={allowed => update('aiConsent', allowed)}>I allow approved profile context to be processed by the configured model provider.</Checkline>
        </>}
        <div className="form-actions">{step > 0 && <Button kind="secondary" onClick={() => setStep(step - 1)}>Back</Button>}<Button type="submit" disabled={busy || (step === 2 && conflict)}>{step === 2 ? 'Save private profile' : 'Continue'}{step === 2 ? <Check size={16} /> : <ArrowRight size={16} />}</Button></div>
      </form>
    </section>

    <aside className="profile-preview stack">
      <section className="panel preview-panel"><Tag><Globe2 size={14} /> Public profile preview</Tag><div className="avatar large">{profile.publicFields.includes('displayName') ? profile.displayName.slice(0, 1) || 'Y' : <Users size={29} aria-hidden="true" />}</div><h2>{profile.publicFields.includes('displayName') ? profile.displayName || 'Your name' : 'Your name is private.'}</h2><p>{profile.publicFields.includes('headline') ? profile.headline || 'Your introduction will appear here.' : 'Your headline is private.'}</p>{profile.publicFields.includes('bio') && <p>{profile.bio}</p>}{profile.publicFields.includes('seeking') && profile.seeking && <p><strong>Looking for:</strong> {profile.seeking}</p>}{profile.publicFields.includes('offering') && profile.offering && <p><strong>Can offer:</strong> {profile.offering}</p>}<div className="tags">{profile.publicFields.includes('tags') && profile.tags.filter(Boolean).map(topic => <Tag key={topic}>{topic}</Tag>)}</div></section>
      <section className="profile-privacy-note"><LockKeyhole size={23} /><h3>A private foundation.</h3><p>Your contacts, employer and conversations are never published to ENS or Arkiv. This preview reflects your current draft, not a public write.</p></section>
    </aside>
  </div>;
}
