import { z } from 'zod';
import { HttpError } from './security';

const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine(value => {
    if (!Number.isFinite(Date.parse(value))) return false;
    const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
    return year >= 1970 && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
      && hour < 24 && minute < 60 && second < 60;
  }, 'Use a real calendar date with an explicit UTC offset.');
export const availabilitySchema = z.object({
  timezone: z.string().min(1).max(80).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Choose a valid timezone.'),
  durationMinutes: z.number().int().min(15).max(120).refine(value => value % 5 === 0),
  intervals: z.array(z.object({ start: instant, end: instant }).strict()).min(1).max(20),
  shareForThisMeeting: z.literal(true),
}).strict();
export type Availability = z.infer<typeof availabilitySchema>;
export type MeetingSlot = { start: string; end: string };
export function normalizeAvailability(input: unknown, now = Date.now()): Availability {
  const value = availabilitySchema.parse(input);
  const intervals = value.intervals.map(interval => ({ start: Date.parse(interval.start), end: Date.parse(interval.end) })).sort((a, b) => a.start - b.start);
  if (intervals.some(interval => interval.start <= now || interval.end <= interval.start || interval.end > now + 60 * 86400000 || interval.end - interval.start > 24 * 3600000)) {
    throw new HttpError(400, 'INVALID_AVAILABILITY', 'Choose future intervals of at most 24 hours within the next 60 days.');
  }
  const merged: typeof intervals = [];
  for (const interval of intervals) {
    const prior = merged.at(-1);
    if (prior && interval.start <= prior.end) prior.end = Math.max(prior.end, interval.end);
    else merged.push({ ...interval });
  }
  return { ...value, intervals: merged.map(interval => ({ start: new Date(interval.start).toISOString(), end: new Date(interval.end).toISOString() })) };
}

/** Inputs are instants with explicit offsets. The timezone labels never guess an ambiguous DST wall time. */
export function overlappingSlots(left: Availability, right: Availability, now = Date.now()): MeetingSlot[] {
  if (left.durationMinutes !== right.durationMinutes) return [];
  const duration = left.durationMinutes * 60000, slots: MeetingSlot[] = [];
  for (const a of left.intervals) for (const b of right.intervals) {
    const start = Math.max(Date.parse(a.start), Date.parse(b.start));
    const end = Math.min(Date.parse(a.end), Date.parse(b.end));
    if (start > now && end - start >= duration) slots.push({ start: new Date(start).toISOString(), end: new Date(start + duration).toISOString() });
  }
  return [...new Map(slots.sort((a, b) => a.start.localeCompare(b.start)).map(slot => [slot.start + slot.end, slot])).values()].slice(0, 5);
}
