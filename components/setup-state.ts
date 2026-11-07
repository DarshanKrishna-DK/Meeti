import type { AppState } from '@/packages/shared/src';

export type NameClaim = {
  id: string; version: number; label: string; state: string; recipient: string; userName: string; agentName: string;
  recipientRegistry?: string; userRegistry?: string; agentConfirmed: false;
  receipts: { hash: string; operation: string; blockNumber: string }[];
};
export function confirmedName(claim: NameClaim | null | undefined): claim is NameClaim & { state: 'confirmed' } {
  return claim?.state === 'confirmed' && claim.receipts.some(receipt => receipt.operation === 'issue-project-subname');
}
export function nameRequestStatus(claim: NameClaim | null | undefined) {
  if (!claim) return { label: 'Choose a name', title: 'A name of your own.', description: 'Choose how your networking identity will appear.', step: 0 };
  if (confirmedName(claim)) return { label: 'Registration confirmed', title: 'Your name is registered.', description: 'The registration receipt is confirmed. Your agent still needs its own setup and permission check.', step: 2 };
  if (claim.state === 'requested') return { label: 'Request received', title: 'Your name request is saved.', description: 'The Meeti issuer must approve and register this name. Registration is not automatic, and waiting or refreshing does not start it. You can finish your profile while registration is arranged.', step: 1 };
  if (claim.state === 'prepared') return { label: 'Review prepared', title: 'Registration is being reviewed.', description: 'A transaction review is prepared. This does not mean a transaction has been sent or confirmed.', step: 1 };
  if (claim.state === 'withdrawn') return { label: 'Request withdrawn', title: 'Choose a different name.', description: 'Your request is withdrawn. You can review another name below.', step: 0 };
  return { label: 'Check registration', title: 'Registration needs a check.', description: 'Refresh the request before continuing. A confirmed name has not been established here.', step: 1 };
}
export function profileSaved(state: AppState) { return Boolean(state.profile.displayName.trim() && state.profile.seeking.trim() && state.profile.offering.trim()); }
/** Navigation hints describe saved records. They never grant permissions or complete the guide. */
export function nextSetupAction(state: AppState, claim?: NameClaim | null, now = Date.now()) {
  if (!profileSaved(state)) return { label: 'Continue guided setup', href: null, copy: 'Start with what you seek and what you can offer.' };
  if ((state.agentTasks || []).some(task => task.status === 'queued' || task.status === 'running')) return { label: 'Follow your agent', href: '/activity', copy: 'A saved request is in progress. Follow it before starting another.' };
  const permissionsChecked = Boolean(state.agent?.authority?.allowed && !state.agent.policy.paused && Date.parse(state.agent.policy.expiresAt) > now);
  if (state.agent && !permissionsChecked) return { label: 'Check agent permissions', href: '/agent#agent-profile', copy: 'Finish your agent setup and check its current permissions before continuing.' };
  if (state.proposals.some(proposal => !proposal.myConsent && ['proposed', 'waiting_consents'].includes(proposal.status))) return { label: 'Review your introductions', href: '/approvals', copy: 'A proposal is waiting for your decision.' };
  if (permissionsChecked && state.intents.some(intent => intent.status === 'published' && intent.publicStatus !== 'closed' && Date.parse(intent.expiresAt) > now && Boolean(intent.arkivKey) && Boolean(intent.transactionHash))) return { label: 'Find connections', href: '/discover', copy: 'Your published intention is ready for a search. Each protected action checks current permissions again.' };
  if (state.agent) return { label: 'Write your intention', href: '/intents', copy: 'Explain who you want to meet. Live permissions will be checked before publication.' };
  if (confirmedName(claim)) return { label: 'Set up your agent', href: '/agent#name-request', copy: 'Your name registration is confirmed. Next, review your agent and its permissions.' };
  if (claim && ['requested', 'prepared'].includes(claim.state)) return { label: 'Check your name request', href: '/agent#name-request', copy: 'Your request is saved. Registration is still pending.' };
  return { label: 'Choose your Meeti name', href: '/agent#name-request', copy: 'Request a name for your agent or recover an existing identity.' };
}
