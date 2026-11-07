import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { inlinePolicyDigest } from '../packages/ens';
import { decrypt } from '../packages/server/crypto';
import type { AppState } from '../packages/shared/src';
import { EVENT_ORIGIN, EVENT_VAULT_CONTEXT, EVENT_VAULT_PATH, eventVaultSchema } from './event-demo-accounts';
import type { EventEntry } from './event-demo-execute';

class ImportError extends Error { constructor(readonly code: string) { super(code); } }
function requireValue(value: unknown, code: string): asserts value { if (!value) throw new ImportError(code); }
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
async function main() {
  requireValue(process.argv.length === 3, 'event_import_exact_review_required');
  const raw = readFileSync('artifacts/event-demo-testnet-review.json', 'utf8'), hash = createHash('sha256').update(raw).digest('hex');
  requireValue(process.argv[2] === `--review-sha256=${hash}`, 'event_import_review_hash_mismatch');
  const approval = JSON.parse(readFileSync('.local-data/event-demo-testnet-approval.json', 'utf8'));
  requireValue(approval.authorized === true && approval.reviewSha256 === hash, 'event_import_original_approval_required');
  const review = JSON.parse(raw) as { accounts: { label: string; accountId: string; owner: string; delegate: string; agentName: string }[]; ens: { recipients: { agentName: string; policyDigest: string }[] } };
  const journal = decrypt<{ version: number; reviewSha256: string; entries: EventEntry[] }>(readFileSync('.local-data/event-demo-testnet-journal.enc', 'utf8'), `meeti-event-testnet-journal-v1:${hash}`);
  requireValue(journal.version === 1 && journal.reviewSha256 === hash && ['event-krishna-grant', 'event-viha-grant'].every(id => journal.entries.some(entry => entry.id === id && entry.state === 'confirmed' && entry.hash && entry.receipt)), 'event_import_requires_both_confirmed_grants');
  const vault = eventVaultSchema.parse(decrypt<unknown>(readFileSync(EVENT_VAULT_PATH, 'utf8'), EVENT_VAULT_CONTEXT));
  for (const label of ['krishna', 'viha']) {
    const account = review.accounts.find(account => account.label === label), wallet = vault.wallets.find(wallet => wallet.label === label);
    requireValue(account && wallet && wallet.accountId === account.accountId && /^meeti_session=[a-f0-9]{64}$/.test(wallet.session || ''), 'event_import_authenticated_account_binding_required');
    const recipient = review.ens.recipients.find(recipient => recipient.agentName === account.agentName); requireValue(recipient, 'event_import_review_policy_missing');
    async function api<T>(path: string, body?: unknown) {
      const response = await fetch(`${EVENT_ORIGIN}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(120000), headers: { origin: EVENT_ORIGIN, cookie: wallet!.session!, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      requireValue(response.ok, `event_import_http_${response.status}`);
      const parsed = await response.json(); requireValue(parsed && 'data' in parsed && !parsed.error, 'event_import_response_invalid'); return parsed.data as T;
    }
    let state = await api<AppState>('state');
    requireValue(state.user.id === account.accountId && state.user.wallet && same(state.user.wallet, account.owner) && state.integrations.world.status === 'deferred', 'event_import_current_account_or_world_state_changed');
    if (!state.agent) {
      const preview = await api<{ policyDigest: string; ensName: string; owner: string; delegate: string }>('agent/import/preview', { ensName: account.agentName, delegate: account.delegate });
      requireValue(preview.policyDigest === recipient.policyDigest && preview.ensName === account.agentName && same(preview.owner, account.owner) && same(preview.delegate, account.delegate), 'event_import_preview_changed');
      await api('agent/import', { ensName: account.agentName, delegate: account.delegate, reviewedDigest: preview.policyDigest });
      state = await api<AppState>('state');
    }
    requireValue(state.user.id === account.accountId && state.agent && state.agent.ensName === account.agentName && same(state.agent.owner, account.owner) && same(state.agent.delegate, account.delegate)
      && inlinePolicyDigest(state.agent.policy) === recipient.policyDigest && !state.agent.policy.paused && Date.parse(state.agent.policy.expiresAt) > Date.now(), 'event_import_confirmed_agent_readback_failed');
    z.string().uuid().parse(state.agent.id);
    console.log(JSON.stringify({ label, accountId: account.accountId, agentId: state.agent.id, ensName: state.agent.ensName, policyDigest: recipient.policyDigest, apiReadback: 'confirmed', world: 'paused', modelCalls: 0, signatures: 0, broadcasts: 0 }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main().catch(error => { console.error(error instanceof ImportError ? error.code : 'event_import_failed_no_private_diagnostics'); process.exitCode = 1; });
