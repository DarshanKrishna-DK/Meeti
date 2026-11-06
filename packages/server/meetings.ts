import { atomic, audit, db, proposal } from './db';
import { decrypt, encrypt, hash } from './crypto';
import { assertPair, ownedProposal, requireBothConsents, requireWorld, validatePair } from './proposals';
import { HttpError, requireValue } from './security';
import { normalizeAvailability, overlappingSlots, type Availability, type MeetingSlot } from './meeting-time';
import { worldEnabled } from './capabilities';

export type MeetingPlan = {
  schemaVersion: 1; proposalDigest: string; version: number;
  availability: Record<string, Availability>; slots: MeetingSlot[]; selected: MeetingSlot | null;
  confirmations: Record<string, { version: number; slotDigest: string; confirmedAt: string }>;
  state: 'collecting' | 'no_overlap' | 'duration_mismatch' | 'proposed' | 'confirmed_pending_verification' | 'agreed' | 'cancelled';
  updatedAt: string;
};
function read(id: string): MeetingPlan | null {
  const row = db().prepare('SELECT data FROM meeting_plans WHERE proposal_id=?').get(id) as { data: string } | undefined;
  return row ? decrypt<MeetingPlan>(row.data, `meeting:${id}`) : null;
}
function save(id: string, value: MeetingPlan) {
  db().prepare('INSERT INTO meeting_plans VALUES(?,?,?,?) ON CONFLICT(proposal_id) DO UPDATE SET version=excluded.version,data=excluded.data,updated_at=excluded.updated_at')
    .run(id, value.version, encrypt(value, `meeting:${id}`), value.updatedAt);
}
function fresh(id: string, digest: string): MeetingPlan {
  const value = read(id);
  if (!value || value.proposalDigest !== digest) return { schemaVersion: 1, proposalDigest: digest, version: (value?.version || 0) + 1, availability: {}, slots: [], selected: null, confirmations: {}, state: 'collecting', updatedAt: new Date().toISOString() };
  return value;
}
function requireVersion(value: MeetingPlan, expectedVersion: number) {
  if (value.version !== expectedVersion) throw new HttpError(409, 'MEETING_CHANGED', 'This meeting proposal changed. Refresh it before continuing.');
}
function slotDigest(value: MeetingPlan) { return hash(JSON.stringify({ proposalDigest: value.proposalDigest, version: value.version, slot: value.selected })); }
export function meetingDto(userId: string, id: string) {
  const p = ownedProposal(userId, id);
  assertPair(p); requireBothConsents(p);
  const value = fresh(id, p.row.digest);
  return { proposalId: id, version: value.version, state: value.state, ownAvailability: value.availability[userId] || null,
    otherAvailabilitySubmitted: Boolean(value.availability[p.row.left_user === userId ? p.row.right_user : p.row.left_user]),
    slots: value.slots, selected: value.selected, confirmedByMe: value.confirmations[userId]?.version === value.version,
    confirmationCount: Object.values(value.confirmations).filter(item => item.version === value.version).length,
    updatedAt: value.updatedAt, finalGate: worldEnabled() ? 'Fresh verification is required before agreement.' : 'World is paused. Final meeting agreement remains locked.',
    externalInvitationCreated: false };
}
export async function meetingAction(userId: string, id: string, input: { action: 'availability' | 'select' | 'confirm' | 'finalize' | 'cancel'; version: number; availability?: unknown; slot?: MeetingSlot }, checkSession: () => void) {
  const p = ownedProposal(userId, id);
  // Cancellation remains possible when a provider is unavailable.
  if (input.action !== 'cancel') { await validatePair(p, 'introduce'); requireBothConsents(p); }
  checkSession();
  return atomic(() => {
    const currentProposal = requireValue(proposal(id), 'Introduction is unavailable.', 404);
    if (currentProposal.row.digest !== p.row.digest) throw new HttpError(409, 'PROPOSAL_CHANGED', 'The introduction changed while checking permissions. Review its current version.');
    if (input.action !== 'cancel') { assertPair(currentProposal); requireBothConsents(currentProposal); }
    const value = fresh(id, currentProposal.row.digest);
    requireVersion(value, input.version);
    if (input.action === 'cancel') {
      value.version++; value.state = 'cancelled'; value.selected = null; value.slots = []; value.confirmations = {}; value.availability = {};
    } else if (input.action === 'availability') {
      const normalized = normalizeAvailability(input.availability);
      if (JSON.stringify(value.availability[userId]) === JSON.stringify(normalized) && value.state !== 'cancelled') return { version: value.version, state: value.state };
      value.availability[userId] = normalized; value.version++; value.confirmations = {}; value.selected = null;
      const left = value.availability[p.row.left_user], right = value.availability[p.row.right_user];
      value.slots = left && right ? overlappingSlots(left, right) : [];
      value.state = !left || !right ? 'collecting' : left.durationMinutes !== right.durationMinutes ? 'duration_mismatch' : value.slots.length ? 'proposed' : 'no_overlap';
      value.selected = value.slots[0] || null;
    } else if (input.action === 'select') {
      if (value.state === 'cancelled' || !input.slot || !value.slots.some(slot => slot.start === input.slot!.start && slot.end === input.slot!.end)) throw new HttpError(409, 'INVALID_SLOT', 'Choose one of the current overlapping times.');
      if (JSON.stringify(value.selected) !== JSON.stringify(input.slot)) { value.version++; value.selected = input.slot; value.confirmations = {}; value.state = 'proposed'; }
    } else if (input.action === 'confirm') {
      if (!value.selected || !['proposed', 'confirmed_pending_verification'].includes(value.state) || Date.parse(value.selected.start) <= Date.now()) throw new HttpError(409, 'SLOT_UNAVAILABLE', 'Review a current future meeting proposal before confirming.');
      value.confirmations[userId] = { version: value.version, slotDigest: slotDigest(value), confirmedAt: new Date().toISOString() };
      if ([p.row.left_user, p.row.right_user].every(owner => value.confirmations[owner]?.version === value.version && value.confirmations[owner]?.slotDigest === slotDigest(value))) value.state = 'confirmed_pending_verification';
    } else {
      if (value.state !== 'confirmed_pending_verification' || !value.selected || Date.parse(value.selected.start) <= Date.now()) throw new HttpError(409, 'CONFIRMATIONS_REQUIRED', 'Both people must confirm the same current future time.');
      const left = value.availability[p.row.left_user], right = value.availability[p.row.right_user];
      if (!left || !right || !overlappingSlots(left, right).some(slot => slot.start === value.selected!.start && slot.end === value.selected!.end)
        || ![p.row.left_user, p.row.right_user].every(owner => value.confirmations[owner]?.version === value.version && value.confirmations[owner]?.slotDigest === slotDigest(value))) {
        throw new HttpError(409, 'CONFIRMATIONS_REQUIRED', 'Both people must confirm the same currently available time.');
      }
      requireWorld(id);
      value.state = 'agreed';
    }
    value.updatedAt = new Date().toISOString(); save(id, value);
    audit(userId, 'meeting_time', input.action, `Meeting proposal ${id}, version ${value.version}, state ${value.state}. No calendar invitation was sent.`);
    return { version: value.version, state: value.state };
  });
}
