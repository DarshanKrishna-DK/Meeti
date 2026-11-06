'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, Clock3, RefreshCw } from 'lucide-react';
import type { Candidate, Intent } from '@/packages/shared/src';
import { Button, Checkline, Tag, api, type Shared } from './workspace-features';

type DiscoveryResult = {
  candidates: Candidate[];
  observedBlocks?: string[];
  coverage?: { scannedCandidates: number; candidateLimit: number; unconfirmed: number; truncated: boolean };
};
type DiscoveryJob = {
  intentId: string; active: boolean; checkedAt: string | null; nextRunAt: string | null;
  running: boolean; failureCode: string | null; result: DiscoveryResult | null;
};
type DiscoveryScheduleStatus = {
  enabled: boolean; cadenceSeconds: 60; hostRequirement: string; jobs: DiscoveryJob[];
};

function timestamp(value: string | null) { return value ? Date.parse(value) : NaN; }
function time(value: string | null) {
  return Number.isFinite(timestamp(value)) ? new Date(value!).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
}
function activeIntent(intent: Intent, now: number) {
  return intent.status === 'published' && intent.publicStatus !== 'closed' && Date.parse(intent.expiresAt) > now;
}

export function DiscoverySchedule(props: Shared) {
  return <AccountDiscoverySchedule key={props.state.user.id} {...props} />;
}

function AccountDiscoverySchedule({ state, run, busy }: Shared) {
  const [status, setStatus] = useState<DiscoveryScheduleStatus | null>(null);
  const [disclosureConsent, setDisclosureConsent] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const intentRevisions = state.intents.map(intent => `${intent.id}:${intent.version}:${intent.status}:${intent.publicStatus || 'active'}`).join('|');

  useEffect(() => {
    if (busy || saving) return;
    let cancelled = false;
    let inFlight = false;
    async function refresh() {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      setRefreshing(true);
      try {
        const next = await api<DiscoveryScheduleStatus>('discovery/jobs');
        if (cancelled) return;
        if (!next || typeof next.enabled !== 'boolean' || next.cadenceSeconds !== 60 || typeof next.hostRequirement !== 'string' || !Array.isArray(next.jobs)) {
          throw new Error('The server returned an unreadable discovery schedule. Refresh the status before changing this setting.');
        }
        setStatus(next); setReadError(''); setNow(Date.now());
      } catch (error) {
        if (!cancelled) { setReadError(error instanceof Error ? error.message : 'Discovery status is unavailable. Refresh to try again.'); setNow(Date.now()); }
      } finally { inFlight = false; if (!cancelled) setRefreshing(false); }
    }
    void refresh();
    const update = () => { if (!cancelled) { setNow(Date.now()); void refresh(); } };
    const interval = window.setInterval(update, 15_000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { cancelled = true; window.clearInterval(interval); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [busy, saving, refreshVersion, intentRevisions, state.profile.aiConsent]);

  async function changeSetting(enabled: boolean) {
    if (enabled && (!state.profile.aiConsent || !disclosureConsent)) throw new Error('Approve model processing in your profile and review scheduled discovery consent before enabling checks.');
    setSaving(true);
    try {
      await api('discovery/settings', { enabled, ...(enabled ? { providerDisclosureConsent: true } : {}) });
      setDisclosureConsent(false); setStatus(null); setReadError(''); setRefreshVersion(value => value + 1);
    } finally { setSaving(false); }
  }

  const enabled = status?.enabled === true;
  const jobs = (status?.jobs || []).flatMap(job => {
    const intent = state.intents.find(value => value.id === job.intentId);
    return intent ? [{ job, intent }] : [];
  });
  const controlsBusy = busy || saving || refreshing;
  return <section className="panel form-panel saved-intents" aria-labelledby="discovery-schedule-title">
    <div className="panel-title"><div><h2 id="discovery-schedule-title">A regular check for new connections.</h2><p className="small-copy">Choose whether the host checks active published intents every minute.</p></div><Tag>{status ? enabled ? 'Scheduling enabled' : 'Scheduling off' : 'Setting not loaded'}</Tag></div>
    <p>{status?.hostRequirement || 'Scheduled discovery requires this host to stay awake with Meeti and its discovery worker running. A sleeping or offline host cannot perform checks.'}</p>
    {!state.profile.aiConsent && <p className="draft-warning">Model processing consent is required before enabling scheduled discovery. You can review this choice in your <Link className="inline-link" href="/profile">private profile</Link>.</p>}
    {!enabled && <fieldset className="workspace-controls" disabled={controlsBusy || !state.profile.aiConsent}>
      <Checkline checked={disclosureConsent} onChange={setDisclosureConsent}>I approve sending approved public intent subjects to the configured embedding provider during scheduled checks.</Checkline>
    </fieldset>}
    <div className="form-actions">
      <button className="button" type="button" role="switch" aria-checked={enabled} aria-label="Scheduled discovery" disabled={controlsBusy || !status || (!enabled && (!state.profile.aiConsent || !disclosureConsent))} onClick={() => void run(() => changeSetting(!enabled), enabled ? 'Scheduled discovery disabled.' : 'Scheduled discovery enabled. The host worker must be running.')}>
        <Clock3 size={16} />{saving ? 'Saving setting...' : enabled ? 'Turn off scheduled discovery' : 'Turn on scheduled discovery'}
      </button>
      <Button kind="secondary" disabled={controlsBusy} onClick={() => setRefreshVersion(value => value + 1)}><RefreshCw size={15} />{refreshing ? 'Refreshing status...' : 'Refresh status'}</Button>
    </div>
    {readError && <p className="draft-warning" role="alert">{readError} Any result below is a previous observation. Refresh status to retry.</p>}
    <p className="small-copy">Results record a completed check. Opening a proposal requires fresh Arkiv records and current permissions. Your introduction decisions remain yours.</p>
    {status && !jobs.length && <p role="status">{enabled ? 'No scheduled intent jobs are recorded yet. Active published intents can be checked when the host worker is available.' : 'Scheduled discovery is off. Your published intents can still be searched manually.'}</p>}
    {jobs.map(({ job, intent }) => {
      const live = activeIntent(intent, now);
      const checked = timestamp(job.checkedAt);
      const due = timestamp(job.nextRunAt);
      const recent = Number.isFinite(checked) && checked <= now + 1000 && now - checked <= 90_000;
      const overdue = enabled && job.active && live && !job.running && Number.isFinite(due) && now - due > 60_000;
      const label = !enabled ? 'Scheduling off' : !state.profile.aiConsent ? 'AI consent required' : !live || !job.active ? 'Intent inactive'
        : job.failureCode ? 'Last check blocked' : job.running ? 'Check in progress' : overdue ? 'Worker check overdue' : recent ? 'Recent observation' : job.checkedAt ? 'Previous observation' : 'Awaiting a worker check';
      const candidates = job.result?.candidates || [];
      return <article className="saved-intent" key={job.intentId}>
        <div className="saved-intent-heading"><div><Tag>{label}</Tag><span>Intent revision {intent.version}</span></div></div>
        <h3>{intent.summary}</h3>
        <div className="saved-intent-meta"><span>Last completed check: {time(job.checkedAt)}</span><span>Next eligible check: {enabled && job.active && live ? time(job.nextRunAt) : 'Not scheduled'}</span></div>
        {job.running && enabled && <p className="small-copy" role="status">The host reports a check in progress. Results appear after its checks complete.</p>}
        {overdue && <p className="draft-warning">A scheduled check is overdue. Keep the host awake and check that the discovery worker is running. The saved result does not establish current permissions.</p>}
        {job.failureCode && <div className="permission-result" role="status"><strong>The last check could not complete.</strong><p>{/embed|matching|model/i.test(job.failureCode) ? 'The embedding provider could not complete the comparison. Restore the configured provider, then use manual discovery or wait for the next scheduled check.' : 'Review current intent permissions and provider availability, then use manual discovery or wait for the next scheduled check.'}</p><details><summary>Check diagnostic</summary><code>{job.failureCode}</code></details></div>}
        {job.result && <div className="permission-result">
          <strong>{candidates.length ? `${candidates.length} possible ${candidates.length === 1 ? 'connection' : 'connections'} in the saved observation` : 'No compatible candidates in the saved observation'}</strong>
          {(!recent || !!readError || !!job.failureCode || !live || !enabled) && <p>This is a previous result. Run a fresh discovery check before acting on a candidate.</p>}
          {job.result.coverage && <p>Bounded search: {job.result.coverage.scannedCandidates} candidates reviewed, limit {job.result.coverage.candidateLimit}. {job.result.coverage.unconfirmed} unconfirmed identities or inboxes excluded.{job.result.coverage.truncated ? ' More records may exist outside this budget.' : ''}</p>}
          {candidates.map(candidate => <details key={candidate.key}><summary>{candidate.ensAgentRef}{candidate.demoOrigin ? ' (fictional demonstration)' : ''}</summary><p>{candidate.summary}</p><small>Arkiv intent {candidate.intentId}, revision {candidate.version}. Eligibility and consent require fresh checks.</small></details>)}
        </div>}
      </article>;
    })}
    <div className="form-actions"><Link className="button secondary" href="/discover">Open manual discovery<ArrowRight size={15} /></Link></div>
  </section>;
}
