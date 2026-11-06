'use client';

import { useEffect, useRef, useState } from 'react';
import { CalendarDays, LockKeyhole, RefreshCw } from 'lucide-react';
import type { Proposal } from '@/packages/shared/src';
import { api, Button, Checkline, Field, Tag, type Shared } from './workspace-features';
import styles from './context-library.module.css';

type Slot = { start: string; end: string };
type Availability = { timezone: string; durationMinutes: number; intervals: Slot[]; shareForThisMeeting: true };
type Meeting = { proposalId: string; version: number; state: string; ownAvailability: Availability | null; otherAvailabilitySubmitted: boolean;
  slots: Slot[]; selected: Slot | null; confirmedByMe: boolean; confirmationCount: number; finalGate: string; externalInvitationCreated: false };
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function formatTime(value: string, timezone: string) {
  try { return new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
  catch { return value; }
}

export function hasCurrentMeetingApprovals(proposal: Proposal) {
  const latest = new Map<string, Proposal['consents'][number]>();
  for (const consent of proposal.consents) latest.set(consent.userId, consent);
  return proposal.myConsent === 'approve' && latest.size === 2
    && [...latest.values()].every(consent => consent.decision === 'approve' && consent.digest === proposal.digest)
    && !['declined', 'revoked', 'expired', 'blocked'].includes(proposal.status);
}

export function MeetingPanel(props: Shared & { proposal: Proposal }) {
  return <OwnerMeetingPanel key={`${props.state.user.id}:${props.proposal.id}`} {...props} />;
}

function OwnerMeetingPanel({ state, proposal, run, busy }: Shared & { proposal: Proposal }) {
  const [meeting, setMeeting] = useState<Meeting | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const [timezone, setTimezone] = useState('UTC'), [duration, setDuration] = useState(30), [intervals, setIntervals] = useState<Slot[]>([{ start: '', end: '' }]), [share, setShare] = useState(false);
  const [opened, setOpened] = useState(false);
  const alive = useRef(true), actionPending = useRef(false), edited = useRef(false), epoch = useRef(0);
  const worldReady = state.integrations.world.status === 'ready';
  const endpoint = `proposals/${proposal.id}/meeting`;

  useEffect(() => {
    alive.current = true;
    if (!opened) return () => { alive.current = false; };
    const update = async () => {
      if (actionPending.current || document.visibilityState !== 'visible') return;
      const request = ++epoch.current;
      try {
        const result = await api<Meeting>(endpoint);
        if (alive.current && request === epoch.current) {
          setMeeting(result); setError('');
          if (!edited.current && result.ownAvailability) { setTimezone(result.ownAvailability.timezone); setDuration(result.ownAvailability.durationMinutes); setIntervals(result.ownAvailability.intervals); }
        }
      } catch (cause) { if (alive.current && request === epoch.current) setError(cause instanceof Error ? cause.message : 'Meeting availability could not be loaded.'); }
      finally { if (alive.current && request === epoch.current) setLoading(false); }
    };
    void update();
    return () => { alive.current = false; };
  }, [endpoint, opened]);

  async function refresh() {
    const request = ++epoch.current, result = await api<Meeting>(endpoint);
    if (alive.current && request === epoch.current) { setMeeting(result); setLoading(false); }
  }
  async function perform(task: () => Promise<unknown>, notice?: string) {
    if (busy || actionPending.current) return;
    actionPending.current = true; epoch.current++; setPending(true); setError('');
    try { await run(async () => { try { await task(); await refresh(); } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'This meeting action could not be completed.'); throw cause; } }, notice); }
    finally { actionPending.current = false; if (alive.current) setPending(false); }
  }
  function action(name: 'select' | 'confirm' | 'finalize' | 'cancel', slot?: Slot) {
    if (!meeting) return Promise.resolve();
    return api(endpoint, { action: name, version: meeting.version, ...(slot ? { slot } : {}) });
  }
  function updateInterval(index: number, patch: Partial<Slot>) { edited.current = true; setIntervals(current => current.map((item, position) => position === index ? { ...item, ...patch } : item)); }
  async function saveAvailability() {
    if (!meeting || !share) throw new Error('Approve sharing these availability windows for this meeting first.');
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error('Enter a valid timezone such as Asia/Kolkata or Europe/London.'); }
    if (!Number.isInteger(duration) || duration < 15 || duration > 120 || duration % 5 !== 0) throw new Error('Choose a duration from 15 to 120 minutes in steps of five.');
    const now = Date.now();
    if (intervals.some(slot => !instantPattern.test(slot.start) || !instantPattern.test(slot.end) || !Number.isFinite(Date.parse(slot.start)) || !Number.isFinite(Date.parse(slot.end))
      || Date.parse(slot.start) <= now || Date.parse(slot.end) <= Date.parse(slot.start) || Date.parse(slot.end) > now + 60 * 86400000 || Date.parse(slot.end) - Date.parse(slot.start) > 24 * 3600000)) {
      throw new Error('Use future start and end instants with explicit UTC offsets. Each window must be at most 24 hours and within the next 60 days.');
    }
    await api(endpoint, { action: 'availability', version: meeting.version, availability: { timezone, durationMinutes: duration, intervals, shareForThisMeeting: true } });
    if (alive.current) { edited.current = false; setShare(false); }
  }

  return <details className={styles.originalShare} onToggle={event => setOpened(event.currentTarget.open)}>
    <summary><CalendarDays size={15} /> Find a time together</summary>
    <p className="small-copy">Share availability for this introduction after both current approvals. A suggested time needs each person to confirm it.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {loading ? <p role="status">Loading the current meeting plan...</p> : meeting && <>
      <div className={styles.toolbar}><Tag>{meeting.state.replaceAll('_', ' ')}</Tag><small>Revision {meeting.version}</small><Button kind="secondary" disabled={busy || pending} onClick={() => void perform(refresh)}><RefreshCw size={14} />Refresh plan</Button></div>
      <p role="status" className={styles.notice}>{meeting.finalGate}</p>
      <p className="small-copy">{meeting.otherAvailabilitySubmitted ? 'The other person has submitted availability for this meeting.' : 'The other person has not submitted availability yet.'}</p>
      <form onSubmit={event => { event.preventDefault(); void perform(saveAvailability, 'Your availability was saved for this meeting.'); }}>
        <fieldset className={styles.fieldset} disabled={busy || pending}>
          <div className="two-fields"><Field label="Timezone for displaying your times"><input required maxLength={80} value={timezone} placeholder="Asia/Kolkata" onChange={event => { edited.current = true; setTimezone(event.target.value); }} /></Field><Field label="Meeting duration in minutes"><input type="number" required min={15} max={120} step={5} value={duration} onChange={event => { edited.current = true; setDuration(Number(event.target.value)); }} /></Field></div>
          <p className="small-copy">Enter exact instants, for example 2026-11-10T14:00:00+05:30. The timezone label does not convert or guess a UTC offset.</p>
          <div className={styles.socialRows}>{intervals.map((slot, index) => <div className={styles.socialRow} key={index}>
            <Field label={`Window ${index + 1} start, including offset`}><input required maxLength={35} value={slot.start} placeholder="YYYY-MM-DDTHH:mm:ss+05:30" onChange={event => updateInterval(index, { start: event.target.value })} /></Field>
            <Field label={`Window ${index + 1} end, including offset`}><input required maxLength={35} value={slot.end} placeholder="YYYY-MM-DDTHH:mm:ss+05:30" onChange={event => updateInterval(index, { end: event.target.value })} /></Field>
            {intervals.length > 1 && <Button kind="secondary" onClick={() => { edited.current = true; setIntervals(current => current.filter((_, position) => position !== index)); }}>Remove window {index + 1}</Button>}
          </div>)}</div>
          <div className={styles.toolbar}><Button kind="secondary" disabled={intervals.length >= 20} onClick={() => { edited.current = true; setIntervals(current => [...current, { start: '', end: '' }]); }}>Add availability window</Button></div>
          <Checkline checked={share} onChange={setShare}>I allow these availability windows to be used and shared for this meeting with this counterpart.</Checkline>
          <Button type="submit" disabled={!share}>Save availability</Button>
        </fieldset>
      </form>
      {meeting.state === 'no_overlap' && <p role="status">Your submitted windows do not overlap. You can edit your availability and try again.</p>}
      {meeting.state === 'duration_mismatch' && <p role="status">Your meeting durations differ. Agree on the same duration before a time can be proposed.</p>}
      {meeting.slots.length > 0 && <div className={styles.policyHistory}><h3>Overlapping times</h3><p className="small-copy">Displayed in {meeting.ownAvailability?.timezone || 'UTC'}.</p>{meeting.slots.map(slot => {
        const selected = meeting.selected?.start === slot.start && meeting.selected.end === slot.end;
        return <article key={`${slot.start}:${slot.end}`}><p>{formatTime(slot.start, meeting.ownAvailability?.timezone || 'UTC')} to {formatTime(slot.end, meeting.ownAvailability?.timezone || 'UTC')}</p><Button kind="secondary" disabled={busy || pending || selected || meeting.state === 'agreed'} onClick={() => void perform(() => action('select', slot))}>{selected ? 'Current proposed time' : 'Propose this time'}</Button></article>;
      })}</div>}
      {meeting.selected && <div className={styles.policySummary}><strong>Confirm the same proposed time</strong><p>{formatTime(meeting.selected.start, meeting.ownAvailability?.timezone || 'UTC')} to {formatTime(meeting.selected.end, meeting.ownAvailability?.timezone || 'UTC')}</p><p>{meeting.confirmationCount} of 2 confirmations. {meeting.confirmedByMe ? 'Your confirmation is recorded.' : 'Your confirmation is still needed.'}</p>
        <Button disabled={busy || pending || meeting.confirmedByMe || !['proposed', 'confirmed_pending_verification'].includes(meeting.state)} onClick={() => void perform(() => action('confirm'), 'Your confirmation was recorded for this time and revision.')}>Confirm this proposed time</Button>
        <Button kind="secondary" disabled={busy || pending || !worldReady || meeting.confirmationCount !== 2 || meeting.state !== 'confirmed_pending_verification'} onClick={() => void perform(() => action('finalize'), 'The server recorded the meeting agreement after checking its release gates.')}><LockKeyhole size={14} />Finalize meeting agreement</Button>
      </div>}
      <p className="small-copy">No external calendar invitation has been created. This plan records a proposed time inside Meeti.</p>
      {meeting.state !== 'cancelled' && <button className="text-link danger-text" disabled={busy || pending} onClick={() => void perform(() => action('cancel'), 'This meeting plan has been cancelled.')}>Cancel meeting plan</button>}
    </>}
    {!loading && !meeting && <Button kind="secondary" disabled={busy || pending} onClick={() => void perform(refresh)}>Load meeting plan again</Button>}
  </details>;
}
