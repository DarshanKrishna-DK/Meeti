'use client';

import { useState } from 'react';
import type { Profile } from '@/packages/shared/src';
import { Field } from './workspace-features';
import styles from './context-library.module.css';

type Props = { profile: Profile; update: <Key extends keyof Profile>(key: Key, value: Profile[Key]) => void };
function DetailList({ label, values, maximum, maxLength, onChange }: { label: string; values: string[]; maximum: number; maxLength: number; onChange: (values: string[]) => void }) {
  const canonical = values.join(', ');
  const [editing, setEditing] = useState({ canonical, text: canonical });
  const text = editing.canonical === canonical ? editing.text : canonical;
  return <Field label={label} hint={`Separate up to ${maximum} items with commas. Each item can have up to ${maxLength} characters.`}>
    <input value={text} maxLength={maximum * (maxLength + 2)} onChange={event => {
      const next = event.target.value.split(',').map(item => item.trim()).filter(Boolean);
      event.target.setCustomValidity(next.length > maximum ? `Use at most ${maximum} items.` : next.some(item => item.length > maxLength) ? `Each item must have at most ${maxLength} characters.` : '');
      setEditing({ text: event.target.value, canonical: next.join(', ') }); onChange(next);
    }} />
  </Field>;
}
export function ProfileDetails({ profile, update }: Props) {
  return <details className={styles.policyHistory}>
    <summary>Optional professional context and sharing</summary>
    <p className="small-copy">These details stay in your private account. They are your own claims, not verified credentials. Saving them does not publish them to ENS or Arkiv or change a public intent.</p>
    <DetailList label="Your roles" values={profile.roles || []} maximum={8} maxLength={80} onChange={values => update('roles', values)} />
    <DetailList label="Your skills" values={profile.skills || []} maximum={12} maxLength={80} onChange={values => update('skills', values)} />
    <DetailList label="Your interests" values={profile.interests || []} maximum={12} maxLength={80} onChange={values => update('interests', values)} />
    <DetailList label="Your networking goals" values={profile.goals || []} maximum={6} maxLength={160} onChange={values => update('goals', values)} />
    <div className="two-fields">
      <Field label="Broad location" hint="A city or region is enough. Avoid a private address."><input value={profile.location || ''} maxLength={160} onChange={event => update('location', event.target.value)} /></Field>
      <Field label="Timezone" hint="For example, Asia/Kolkata or Europe/London."><input value={profile.timezone || ''} maxLength={80} onChange={event => update('timezone', event.target.value)} placeholder="Asia/Kolkata" autoCapitalize="none" spellCheck={false} /></Field>
    </div>
    <DetailList label="Languages you use" values={profile.languages || []} maximum={8} maxLength={40} onChange={values => update('languages', values)} />
    <Field label="General availability" hint="This is context only. A meeting requires separate intervals and both confirmations."><textarea value={profile.availability || ''} maxLength={600} rows={3} onChange={event => update('availability', event.target.value)} placeholder="Describe only the availability you want your agent to know." /></Field>
    <Field label="Collaboration mode"><select value={profile.collaborationMode || 'unspecified'} onChange={event => update('collaborationMode', event.target.value as Profile['collaborationMode'])}>
      <option value="unspecified">Not specified</option><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="in-person">In person</option>
    </select></Field>
    <Field label="How may your agent use these details?"><select value={profile.contextSharing || 'private-agent'} onChange={event => update('contextSharing', event.target.value as Profile['contextSharing'])}>
      <option value="private-agent">Keep private to my account and personal agent</option>
      <option value="authorized-counterpart">Allow authorized counterpart context</option>
      <option value="ask-first">Ask me before counterpart sharing</option>
    </select></Field>
    <p className="small-copy">Private and ask-first details are withheld from counterpart model exchanges. Authorized sharing additionally requires AI processing consent and a current agent policy that allows Profile context. The bounded projection includes whole fields up to 1500 characters; longer omitted fields remain private. Ask-first answers use the separate conversation approval flow.</p>
  </details>;
}
