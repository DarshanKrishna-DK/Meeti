import type { Agent } from '../shared/src';
import { db } from './store';
import { decrypt } from './crypto';
export type PolicySnapshot = Pick<Agent, 'ensName' | 'delegate' | 'persona' | 'policy'>;
export async function policyHistory(userId: string) {
    const rows = await db().prepare('SELECT version,data,created_at FROM policy_history WHERE user_id=? ORDER BY version DESC LIMIT 50').all(userId) as {
        version: number;
        data: string;
        created_at: string;
    }[];
    return rows.map(row => ({ ...decrypt<PolicySnapshot>(row.data, `policy-history:${userId}:${row.version}`), createdAt: row.created_at }));
}
