import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchAgentTasks } from '../components/api-client';

class Visibility extends EventTarget {
  hidden = false;
  change(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event('visibilitychange')); }
}
let stop: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
async function flush() { await vi.advanceTimersByTimeAsync(0); }

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
