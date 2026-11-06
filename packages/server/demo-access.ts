export type DemoOriginAssessment = {
  usable: boolean;
  origin?: string;
  connection: 'loopback' | 'https' | 'unavailable';
  reason: string;
};

// Readiness advice only. The actual API still enforces its single configured origin.
export function inspectDemoOrigin(input: string | undefined): DemoOriginAssessment {
  const unavailable = (reason: string): DemoOriginAssessment => ({ usable: false, connection: 'unavailable', reason });
  if (!input) return unavailable('Configure APP_ORIGIN before starting the demo.');
  let url: URL;
  try { url = new URL(input); }
  catch { return unavailable('APP_ORIGIN must be an absolute HTTP or HTTPS origin.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    return unavailable('APP_ORIGIN must contain only a scheme, hostname and optional port.');
  }
  if (url.protocol === 'https:') return {
    usable: true, origin: url.origin, connection: 'https',
    reason: 'Use this exact HTTPS origin on both devices. Both browsers must trust its certificate.',
  };
  if (url.protocol !== 'http:') return unavailable('Only an HTTP loopback origin or trusted HTTPS origin is supported.');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    return unavailable('Plain LAN HTTP is unsuitable for the production Secure cookie and wallet secure context. Use USB loopback forwarding or trusted HTTPS.');
  }
  return {
    usable: true, origin: url.origin, connection: 'loopback',
    reason: 'Laptop loopback is configured. A phone cannot reach this laptop address directly. Later mobile access needs a durable HTTPS deployment; authorized USB forwarding is an optional local alternative.',
  };
}
