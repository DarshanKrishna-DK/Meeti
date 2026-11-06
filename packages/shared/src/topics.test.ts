import { describe, expect, it } from 'vitest';
import { hasTopicOverlap, normalizeTopics } from './topics';
describe('reviewed public topic eligibility', () => {
  it('converts model topic suggestions into the exact displayed public index format', () => {
    expect(normalizeTopics(['TypeScript', 'accessible web engineering', ' accessibility ', 'accessibility', '!!!'])).toEqual(['typescript', 'accessible-web-engineering', 'accessibility']);
  });
  it('rejects empty or substring-only overlap and allows exact reviewed topics', () => {
    expect(hasTopicOverlap([], ['community'])).toBe(false);
    expect(hasTopicOverlap(['java'], ['javascript'])).toBe(false);
    expect(hasTopicOverlap(['community', 'typescript'], ['community', 'design'])).toBe(true);
  });
});
