import { afterEach, describe, expect, it, vi } from 'vitest';
import { route } from '../packages/server/hosted-proxy';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('frontend proxy preserves the authenticated backend boundary', () => {
  it('forwards the actual caller origin and cookies only to the configured HTTPS backend', async () => {
    vi.stubEnv('BACKEND_API_ORIGIN', 'https://backend.example');
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { headers: { 'set-cookie': 'meeti_session=fixture; HttpOnly; Secure; SameSite=Strict', 'content-type': 'application/json' } }));
    const response = await route(new Request('https://frontend.example/api/profile', { method: 'POST', headers: { origin: 'https://attacker.example', cookie: 'meeti_session=fixture', 'content-type': 'application/json', 'x-forwarded-host': 'attacker.example' }, body: '{}' }), ['profile']);
    const [target, init] = fetcher.mock.calls[0];
    expect(String(target)).toBe('https://backend.example/api/profile');
    const headers = new Headers(init?.headers);
    expect(headers.get('origin')).toBe('https://attacker.example');
    expect(headers.get('cookie')).toBe('meeti_session=fixture'); expect(headers.has('x-forwarded-host')).toBe(false);
    expect(init?.redirect).toBe('manual'); expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  });
  it('rejects unsafe path traversal and refuses upstream redirects with session cookies', async () => {
    vi.stubEnv('BACKEND_API_ORIGIN', 'https://backend.example');
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://attacker.example' } }));
    expect((await route(new Request('https://frontend.example/api/health'), ['..', 'health'])).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await route(new Request('https://frontend.example/api/health'), ['health'])).status).toBe(502);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('fails closed when the backend is not HTTPS or has embedded credentials', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const origin of ['http://backend.example', 'https://user:password@backend.example', 'https://backend.example/private']) {
      vi.stubEnv('BACKEND_API_ORIGIN', origin);
      expect((await route(new Request('https://frontend.example/api/health'), ['health'])).status).toBe(503);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
