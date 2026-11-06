import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createEnsAuthorityProvider, decodeInlinePolicyUri } from '../ens';
import { agent, atomic, audit, saveAgent } from './store';
import { checkOrigin, HttpError, rateLimit, requireUser } from './security';
import { addressSchema } from './validation';
import type { Agent } from '../shared/src';

const identity = {
  ensName: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+){1,6}\.eth$/).max(253),
  delegate: addressSchema,
};

/** Restore only a current ENS-authorized public identity, never old private memories. */
export async function handleAgentImport(request: Request, key: string, body: unknown): Promise<Response | null> {
  if (key !== 'agent/import/preview' && key !== 'agent/import') return null;
  if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST to review or import an identity.');
  checkOrigin(request);
  const actor = await requireUser(request);
  if (!actor.wallet) throw new HttpError(409, 'WALLET_REQUIRED', 'Sign in with your owner wallet first.');
  if (await agent(actor.id)) throw new HttpError(409, 'AGENT_EXISTS', 'Manage your existing agent rather than replacing its policy through import.');
  const input = (key === 'agent/import'
    ? z.object({ ...identity, reviewedDigest: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict()
    : z.object(identity).strict()).parse(body);
  await rateLimit(`agent-import:${actor.id}`, 8);
  const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
  if (!rpcUrl) throw new HttpError(503, 'ENS_UNCONFIGURED', 'The ENS connection is not configured.');
  const provider = createEnsAuthorityProvider({ rpcUrl });
  const result = await (async () => {
    try { return await provider.checkAuthority({ ensName: input.ensName, owner: actor.wallet!, delegate: input.delegate, action: 'discover' }); }
    finally { await provider.disconnect(); }
  })();
  const currentActor = await requireUser(request);
  if (currentActor.id !== actor.id || currentActor.wallet?.toLowerCase() !== actor.wallet.toLowerCase()) {
    throw new HttpError(403, 'ACCOUNT_CHANGED', 'Your authenticated owner account changed. Review the identity again.');
  }
  if (!result.allowed || !result.publicPolicy || !result.evidence) {
    throw new HttpError(403, 'ENS_IMPORT_DENIED', `This identity could not be imported: ${result.reason}. No permission was assumed.`);
  }
  let policy;
  try { policy = decodeInlinePolicyUri(result.publicPolicy.uri); }
  catch { throw new HttpError(422, 'UNSUPPORTED_IMPORT_POLICY', 'This identity does not contain a supported inline policy. Configure its reviewed public policy in agent settings.'); }
  if (!policy.allowedActions.includes('discover') || policy.paused || Date.parse(policy.expiresAt) <= Date.now()) {
    throw new HttpError(403, 'ENS_IMPORT_DENIED', 'The current policy does not permit active discovery.');
  }
  const preview = { ensName: input.ensName, owner: actor.wallet, delegate: input.delegate,
    policy, policyDigest: result.publicPolicy.digest, resolverAddress: result.evidence.resolver,
    checkedAt: result.checkedAt, blockNumber: result.blockNumber };
  if (key === 'agent/import') {
    if (!('reviewedDigest' in input) || typeof input.reviewedDigest !== 'string' || input.reviewedDigest.toLowerCase() !== preview.policyDigest.toLowerCase()) {
      throw new HttpError(409, 'POLICY_CHANGED', 'The public permission policy changed. Review its current values before importing.');
    }
    await atomic(async () => {
      const committingActor = await requireUser(request);
      if (committingActor.id !== actor.id || committingActor.wallet?.toLowerCase() !== actor.wallet!.toLowerCase()) throw new HttpError(403, 'ACCOUNT_CHANGED', 'Your authenticated owner account changed. Review the identity again.');
      if (await agent(actor.id)) throw new HttpError(409, 'AGENT_EXISTS', 'An agent was configured in another session. Refresh before continuing.');
      const value: Agent = { id: randomUUID(), ensName: preview.ensName, owner: preview.owner, delegate: preview.delegate,
        persona: '', policy, config: { resolverAddress: preview.resolverAddress, policyUri: '' },
        authority: { allowed: true, reason: result.reason, checkedAt: result.checkedAt, evidence: result } };
      await saveAgent(actor.id, value);
      await audit(actor.id, 'agent_import', 'completed', 'Imported the exact current ENS identity and public policy after owner review.');
    });
  }
  return Response.json({ data: preview }, { headers: { 'Cache-Control': 'no-store' } });
}
