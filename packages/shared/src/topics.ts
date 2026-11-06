// Adapted from Tacit Protocol matching/scorer.ts, MIT, Copyright (c) 2026 Tacit Protocol Contributors.
// Meeti uses exact canonical topics as an eligibility gate, with no inferred authenticity score.
export function hasTopicOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  for (const term of a) {
    for (const peer of b) {
      if (term === peer) return true;
    }
  }
  return false;
}
export function normalizeTopics(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)).filter(Boolean))];
}
