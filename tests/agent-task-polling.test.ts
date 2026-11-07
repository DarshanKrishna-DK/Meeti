import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, apiEnqueue, watchAgentTasks } from '../components/api-client';

class Visibility extends EventTarget {
  hidden = false;
  change(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event('visibilitychange')); }
}
let stop: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
async function flush() { await vi.advanceTimersByTimeAsync(0); }

describe('enqueue-only client submission with fixture HTTP and no provider calls', () => {
  it.each(['queued', 'running'] as const)('returns an authenticated %s descriptor immediately without polling or resubmitting', async status => {
    const taskId = randomUUID(), body = { intentId: randomUUID(), candidateKey: `0x${'aa'.repeat(32)}` };
    const fetcher = vi.fn(async () => Response.json({ data: { taskId, status, deduplicated: status === 'running' } }, { status: 202 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(apiEnqueue('proposals', body)).resolves.toEqual({ kind: 'queued', taskId, status, deduplicated: status === 'running' });
    expect(fetcher).toHaveBeenCalledWith('/api/proposals', expect.objectContaining({ method: 'POST', body: JSON.stringify(body), credentials: 'same-origin', redirect: 'error' }));
    await vi.advanceTimersByTimeAsync(600000);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('preserves a synchronous local result without claiming a queued task', async () => {
    const result = { id: null, qualificationId: randomUUID() };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: result })));
    await expect(apiEnqueue('proposals', {})).resolves.toEqual({ kind: 'completed', data: result });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { taskId: '../foreign-task', status: 'queued', deduplicated: false },
    { taskId: 'a'.repeat(36), status: 'queued', deduplicated: false },
    { taskId: randomUUID(), status: 'completed', deduplicated: false },
    { taskId: randomUUID(), status: 'queued', deduplicated: 'true' },
    { taskId: randomUUID(), status: 'queued' },
    null,
  ])('rejects a malformed 202 receipt without polling or repeating the mutation', async data => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data }, { status: 202 })));
    await expect(apiEnqueue('proposals', {})).rejects.toThrow('Check Agent activity');
    await vi.advanceTimersByTimeAsync(600000);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not repeat an uncertain submission or a denied request', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('fixture_private_network_details'))
      .mockResolvedValueOnce(Response.json({ error: { message: 'Wait for the current review.' } }, { status: 429 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(apiEnqueue('proposals', {})).rejects.toThrow('Check Agent activity');
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(apiEnqueue('proposals', {})).rejects.toThrow('Wait for the current review.');
    await vi.advanceTimersByTimeAsync(600000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps the existing regular api terminal-polling behavior for other callers', async () => {
    const taskId = randomUUID(), completed = { qualificationId: randomUUID() };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: { taskId, status: 'queued', deduplicated: false } }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ data: { taskId, status: 'running' } }))
      .mockResolvedValueOnce(Response.json({ data: { taskId, status: 'completed', result: completed } }));
    vi.stubGlobal('fetch', fetcher);
    const pending = api('proposals', {});
    await flush(); await vi.advanceTimersByTimeAsync(6000);
    await expect(pending).resolves.toEqual(completed);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/proposals', `/api/agent-tasks/${taskId}`, `/api/agent-tasks/${taskId}`]);
  });
});

describe('visible activity polling of already authorized task IDs with fake HTTP only', () => {
  it('follows queued and running yields through completion with GET only and refreshes each observed step', async () => {
    const id = randomUUID(), refresh = vi.fn(async () => {}), visibility = new Visibility();
    const statuses = ['queued', 'running', 'queued', 'completed'];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined(); expect(init?.credentials).toBe('same-origin');
      return Response.json({ data: { taskId: id, status: statuses.shift() } });
    });
    vi.stubGlobal('fetch', fetcher);
    stop = watchAgentTasks({ taskIds: [id], refresh, visibility });
    await flush(); for (let index = 0; index < 3; index++) await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(4); expect(refresh).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([url]) => url === `/api/agent-tasks/${id}`)).toBe(true);
    await vi.advanceTimersByTimeAsync(20000); expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('pauses while hidden or another action is busy and resumes the same task when visible', async () => {
    const id = randomUUID(), visibility = new Visibility(); visibility.hidden = true;
    let busy = false;
    const fetcher = vi.fn(async () => Response.json({ data: { taskId: id, status: 'queued' } }));
    vi.stubGlobal('fetch', fetcher);
    stop = watchAgentTasks({ taskIds: [id], refresh: async () => {}, paused: () => busy, visibility });
    await vi.advanceTimersByTimeAsync(20000); expect(fetcher).not.toHaveBeenCalled();
    busy = true; visibility.change(false); await vi.advanceTimersByTimeAsync(5000); expect(fetcher).not.toHaveBeenCalled();
    busy = false; await vi.advanceTimersByTimeAsync(5000); expect(fetcher).toHaveBeenCalledOnce();
    visibility.change(true); await vi.advanceTimersByTimeAsync(20000); expect(fetcher).toHaveBeenCalledOnce();
    visibility.change(false); await flush(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('aborts in-flight reads and never refreshes state after unmount or owner scope replacement', async () => {
    const id = randomUUID(), refresh = vi.fn(async () => {}), visibility = new Visibility();
    let resolve!: (response: Response) => void, signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => { signal = init?.signal || undefined; return new Promise<Response>(done => { resolve = done; }); }));
    stop = watchAgentTasks({ taskIds: [id], refresh, visibility });
    await flush(); stop(); expect(signal?.aborted).toBe(true);
    resolve(Response.json({ data: { taskId: id, status: 'completed' } })); await flush();
    expect(refresh).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(10000); expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not overlap slow polls and never resubmits failed work', async () => {
    const id = randomUUID(), refresh = vi.fn(async () => {}), visibility = new Visibility();
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal('fetch', fetcher);
    stop = watchAgentTasks({ taskIds: [id], refresh, visibility });
    await vi.advanceTimersByTimeAsync(15000); expect(fetcher).toHaveBeenCalledOnce();
    resolve(Response.json({ data: { taskId: id, status: 'failed' } })); await flush();
    expect(refresh).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(10000); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('reports recoverable read failures then retries only the same saved task', async () => {
    const id = randomUUID(), onError = vi.fn(), refresh = vi.fn(async () => {});
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('fixture_offline')).mockResolvedValueOnce(Response.json({ data: { taskId: id, status: 'expired' } }));
    vi.stubGlobal('fetch', fetcher);
    stop = watchAgentTasks({ taskIds: [id], refresh, onError, visibility: new Visibility() });
    await flush(); expect(onError).toHaveBeenCalledOnce(); expect(onError.mock.calls[0][0].message).not.toContain('fixture_offline');
    await vi.advanceTimersByTimeAsync(5000); expect(fetcher).toHaveBeenCalledTimes(2); expect(refresh).toHaveBeenCalledOnce();
  });
});
