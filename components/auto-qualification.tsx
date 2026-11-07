'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from './api-client';
import type { Shared } from './workspace-features';
import type { AutoQualificationDto } from '@/packages/server/auto-qualification';

const active = (status: string) => ['queued', 'searching', 'qualifying'].includes(status);
const descriptions: Record<string, string> = {
  queued: 'Your approved search is queued. No conversation has completed.',
  searching: 'Checking active public intentions and current permissions.',
  qualifying: 'Following the selected counterparts one at a time. Actual messages appear below.',
  completed: 'The bounded review is complete. Read each conversation outcome below.',
  no_candidates: 'This bounded search found no eligible counterparts. No conversation was started.',
  blocked: 'Automatic progress stopped. Review the saved task or permission issue before making a new request.',
  cancelled: 'You stopped automatic progress. Previously completed messages remain in history.',
  expired: 'This automatic request expired. It will not restart itself.',
  interrupted: 'A previous step has an uncertain outcome. It will not be repeated automatically.',
};
export function AutoQualificationStatus({ state, run, busy, refresh }: Shared) {
  const [batches, setBatches] = useState<AutoQualificationDto[]>([]), [error, setError] = useState('');
  const current = useRef({ busy, refresh });
  useEffect(() => { current.current = { busy, refresh }; }, [busy, refresh]);
  useEffect(() => {
    let mounted = true, timer: ReturnType<typeof setTimeout> | undefined, loading = false, signature = '';
    const load = async () => {
      if (!mounted || loading) return;
      if (document.hidden || current.current.busy) { timer = setTimeout(load, 5000); return; }
      loading = true;
      try {
        const value = await api<AutoQualificationDto[]>('auto-qualifications');
        if (!mounted) return;
        setBatches(value); setError('');
        const next = JSON.stringify(value);
        if (signature ? signature !== next : value.some(item => item.taskIds.length > 0)) await current.current.refresh?.();
        signature = next;
        if (value.some(item => active(item.status))) timer = setTimeout(load, 5000);
      } catch { if (mounted) { setError('Automatic progress could not refresh. Keep this page open or return later to inspect the saved request.'); timer = setTimeout(load, 5000); } }
      finally { loading = false; }
    };
    const wake = () => { if (timer) clearTimeout(timer); void load(); };
    void load(); document.addEventListener('visibilitychange', wake); window.addEventListener('focus', wake);
    return () => { mounted = false; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); };
  }, [state.user.id]);
  if (!batches.length && !error) return null;
  return <section className="panel form-panel" aria-label="Automatic candidate review"><h2>Your approved automatic search.</h2><p>One search checking at most four public candidate records, with up to two eligible counterparts reviewed sequentially. This is a bounded search. On this deployment, progress may pause when this page is closed. Both people still decide on introductions.</p>{error && <p role="status">{error}</p>}{batches.map(batch => <article className="transaction-preview" key={batch.batchId}><strong>{batch.status.replaceAll('_', ' ')}</strong><p>{descriptions[batch.status]}</p><small>{batch.selectedCount} of at most {batch.maximumCandidates} counterparts selected. {batch.taskIds.length} actual qualification requests saved.</small>{batch.coverage&&<p className="small-copy">{batch.coverage.scannedCandidates} public candidate records checked. {batch.coverage.truncated?'More records exist outside this search budget.':'This is not an exhaustive search.'}</p>}{batch.candidateKeys.length>0&&<details><summary>Selected public intent records</summary>{batch.candidateKeys.map(key=><p className="small-copy" key={key}><code style={{overflowWrap:'anywhere'}}>{key}</code></p>)}</details>}{batch.failureCode && <p className="small-copy">{batch.failureCode.replaceAll('_', ' ')}</p>}{active(batch.status) && <button className="button secondary" disabled={busy} onClick={() => void run(async () => { const updated = await api<AutoQualificationDto>(`auto-qualifications/${batch.batchId}/cancel`, {}); setBatches(previous => previous.map(item => item.batchId === updated.batchId ? updated : item)); }, 'Automatic progress stopped. Completed activity remains in history.')}>Stop automatic review</button>}</article>)}</section>;
}
