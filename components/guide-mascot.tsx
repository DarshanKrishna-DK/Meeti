import { useId, useSyncExternalStore } from 'react';

let highlightedFeature = '';
const highlightListeners = new Set<() => void>();

function subscribeHighlight(update: () => void) {
  highlightListeners.add(update);
  return () => highlightListeners.delete(update);
}

export function highlightFeature(feature: string) {
  highlightedFeature = feature;
  for (const listener of highlightListeners) listener();
}

export function useHighlightedFeature() {
  return useSyncExternalStore(subscribeHighlight, () => highlightedFeature, () => '');
}

export function Mascot({ className = '' }: { className?: string }) {
  const rawId = useId().replace(/:/g, '');
  const body = `${rawId}-body`;
  const side = `${rawId}-side`;
  const head = `${rawId}-head`;
  return <svg className={`mascot ${className}`} viewBox="0 0 300 190" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={body} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#fff" />
        <stop offset="42%" stopColor="var(--paper)" />
        <stop offset="100%" stopColor="var(--surface-tint)" />
      </linearGradient>
      <linearGradient id={side} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.45" />
        <stop offset="100%" stopColor="var(--accent)" />
      </linearGradient>
      <radialGradient id={head} cx="32%" cy="28%" r="75%">
        <stop offset="0%" stopColor="#fff" />
        <stop offset="46%" stopColor="var(--paper)" />
        <stop offset="100%" stopColor="var(--surface-tint)" />
      </radialGradient>
    </defs>
    <ellipse className="mascot-shadow" cx="146" cy="176" rx="82" ry="9" />
    <path fill={`url(#${side})`} d="M198 112l18 12v46l-18-12Z" />
    <path fill={`url(#${side})`} d="M88 168h110l18 12H106Z" />
    <rect x="68" y="90" width="130" height="78" rx="18" fill={`url(#${body})`} stroke="var(--accent)" strokeWidth="2" />
    <path fill={`url(#${side})`} d="M156 34c16 8 26 24 26 42 0 10-3 18-8 26 8-10 12-22 12-36 0-20-12-38-30-46Z" />
    <circle cx="132" cy="62" r="40" fill={`url(#${head})`} stroke="var(--accent)" strokeWidth="2" />
    <ellipse className="mascot-shine" cx="116" cy="46" rx="14" ry="8" />
    <circle className="mascot-ink" cx="118" cy="62" r="4" />
    <circle className="mascot-ink" cx="148" cy="62" r="4" />
    <path className="mascot-line" d="M120 76q16 11 32 0" />
    <path fill={`url(#${side})`} d="M198 124c22-8 42-6 58 8l-8 10c-14-10-30-12-50-6Z" />
    <path className="mascot-arm" d="M196 120c22-8 44-6 62 8" />
    <circle cx="262" cy="130" r="10" fill="var(--rose)" stroke="var(--accent)" strokeWidth="2" />
    <path className="mascot-point" d="M270 122l16-18" />
  </svg>;
}
