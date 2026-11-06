import { describe, expect, it } from 'vitest';
import { normalizeAvailability, overlappingSlots } from '../packages/server/meeting-time';

const now = Date.parse('2026-10-31T00:00:00Z');
function input(start: string, end: string, timezone = 'America/New_York', durationMinutes = 30) {
  return { timezone, durationMinutes, intervals: [{ start, end }], shareForThisMeeting: true };
}
describe('deterministic meeting intervals, without external calendar services', () => {
  it('uses explicit offsets across the repeated DST hour', () => {
    const left = normalizeAvailability(input('2026-11-01T01:15:00-04:00', '2026-11-01T01:45:00-05:00'), now);
    const right = normalizeAvailability(input('2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z', 'UTC'), now);
    expect(overlappingSlots(left, right, now)).toEqual([{ start: '2026-11-01T06:00:00.000Z', end: '2026-11-01T06:30:00.000Z' }]);
  });
  it('merges overlapping intervals and deduplicates resulting slots', () => {
    const left = normalizeAvailability({ ...input('2026-11-02T10:00:00Z', '2026-11-02T11:00:00Z'), intervals: [
      { start: '2026-11-02T10:00:00Z', end: '2026-11-02T11:00:00Z' }, { start: '2026-11-02T10:30:00Z', end: '2026-11-02T12:00:00Z' },
    ] }, now);
    expect(left.intervals).toHaveLength(1);
    expect(overlappingSlots(left, left, now)).toHaveLength(1);
  });
  it.each([
    ['2026-11-31T10:00:00Z', '2026-12-01T11:00:00Z'],
    ['2026-11-02T24:00:00Z', '2026-11-03T01:00:00Z'],
    ['2026-11-02T10:00:00', '2026-11-02T11:00:00'],
    ['2026-10-30T10:00:00Z', '2026-10-30T11:00:00Z'],
    ['2026-11-02T11:00:00Z', '2026-11-02T10:00:00Z'],
  ])('rejects invalid or ambiguous interval %s', (start, end) => {
    expect(() => normalizeAvailability(input(start, end), now)).toThrow();
  });
  it('requires sharing consent, a valid timezone, and bounded duration', () => {
    const valid = input('2026-11-02T10:00:00Z', '2026-11-02T11:00:00Z');
    for (const change of [{ shareForThisMeeting: false }, { timezone: 'Not/AZone' }, { durationMinutes: 17 }, { durationMinutes: 180 }]) {
      expect(() => normalizeAvailability({ ...valid, ...change }, now)).toThrow();
    }
  });
  it('returns no overlap for different durations, disjoint intervals, or elapsed times', () => {
    const left = normalizeAvailability(input('2026-11-02T10:00:00Z', '2026-11-02T11:00:00Z'), now);
    const right = normalizeAvailability(input('2026-11-02T10:00:00Z', '2026-11-02T11:00:00Z', 'UTC', 45), now);
    expect(overlappingSlots(left, right, now)).toEqual([]);
    expect(overlappingSlots(left, left, Date.parse('2026-11-03T00:00:00Z'))).toEqual([]);
    expect(overlappingSlots(left, normalizeAvailability(input('2026-11-02T12:00:00Z', '2026-11-02T13:00:00Z'), now), now)).toEqual([]);
  });
});
