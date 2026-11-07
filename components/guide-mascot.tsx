import { useSyncExternalStore } from 'react';
import { GuideMascotArt } from './guide-mascot-art';

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

export function Mascot(props: { className?: string }) { return <GuideMascotArt {...props} />; }
