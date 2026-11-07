import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { db, closeStore, agent } from '../packages/server/store';
import { createEnsAuthorityProvider } from '../packages/ens';
import { inlinePolicyDigest } from '../packages/ens';
import { decrypt } from '../packages/server/crypto';

const wallet = '0xEE291Bc0246441F53610FbCAF2bC892110e72732';
async function main() {
  if (process.env.DATABASE_PROVIDER !== 'postgres' || !process.env.SUPABASE_DATABASE_URL) throw new Error('presenter_read_requires_postgres');
  try {
    const user = await db().prepare('SELECT id FROM users WHERE lower(wallet)=?').get(wallet.toLowerCase());
    if (!user) { console.log(JSON.stringify({ wallet, accountExists: false, agentExists: false, humanVerified: false, modelCalls: 0, signatures: 0, writes: 0 })); return; }
    const current = await agent(String(user.id));
    if (!current) {
      const claim = await db().prepare('SELECT id,label,state,data FROM namespace_claims WHERE user_id=? AND lower(recipient)=?').get(user.id, wallet.toLowerCase());
      let namespace: { state: unknown; label: unknown; userName: string; agentName: string; receiptCount: number; ownerRead?: { controlled: boolean; subregistryReady: boolean; nextStep: string; subregistry: string; expiresAt: string; blockNumber: string }; readError?: string } | null = null;
      if (claim) {
        const value = decrypt<{ userName: string; agentName: string; receipts: unknown[] }>(String(claim.data), `namespace-claim:${claim.id}`);
        namespace = { state: claim.state, label: claim.label, userName: value.userName, agentName: value.agentName, receiptCount: value.receipts.length };
        const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
        if (rpcUrl) {
          const ens = createEnsAuthorityProvider({ rpcUrl });
          try { const actual = await ens.inspectProjectParent({ parentName: value.userName, issuer: wallet }); namespace.ownerRead = { controlled: true, subregistryReady: actual.nextStep === 'ready', nextStep: actual.nextStep, subregistry: actual.subregistry, expiresAt: actual.expiresAt, blockNumber: actual.blockNumber }; }
          catch { namespace.readError = 'current_name_control_not_verified'; }
          finally { await ens.disconnect(); }
        }
      }
      console.log(JSON.stringify({ wallet, accountExists: true, agentExists: false, namespace, humanVerified: false, modelCalls: 0, signatures: 0, writes: 0 })); return;
    }
    const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
    if (!rpcUrl) throw new Error('presenter_read_requires_ens_rpc');
    const ens = createEnsAuthorityProvider({ rpcUrl });
    try {
      const authority = await ens.checkAuthority({ ensName: current.ensName, owner: current.owner, delegate: current.delegate, action: 'negotiate', policyVersion: String(current.policy.version), policyDigest: inlinePolicyDigest(current.policy) });
      console.log(JSON.stringify({ wallet, accountExists: true, agentExists: true, ensName: current.ensName, ensChainId: 11155111, permissionAllowed: authority.allowed, permissionReason: authority.reason, humanVerified: false, modelCalls: 0, signatures: 0, writes: 0 }));
    } finally { await ens.disconnect(); }
  } finally { await closeStore(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main().catch(() => { console.error('presenter_read_failed_no_profile_or_credentials_logged'); process.exitCode = 1; });
