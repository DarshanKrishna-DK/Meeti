import { db } from './store';
import { decrypt } from './crypto';
import { worldConfigFromEnv } from '../world';
import { worldEnabled } from './capabilities';
export async function hasCurrentWorldVerification(proposalId: string, userId: string, digest: string): Promise<boolean> {
  if (!worldEnabled()) return false;
  let config: ReturnType<typeof worldConfigFromEnv>;
  try { config = worldConfigFromEnv(); } catch { return false; }
  const mode = config.issuer === 'https://sandbox.auth.world.org' ? 'sandbox-test-identity' : 'hackathon-test-identity';
  const rows = await db().prepare('SELECT id,data FROM world_verifications WHERE proposal_id=? AND user_id=? AND digest=? AND expires_at>?').all(proposalId, userId, digest, new Date().toISOString()) as { id: string; data: string }[];
  return rows.some(row => {
    try {
      const value = decrypt<{ issuer: string; clientId: string; identityMode: string }>(row.data, `world:${row.id}`);
      return value.issuer === config.issuer && value.clientId === config.clientId && value.identityMode === mode;
    } catch { return false; }
  });
}
