import { randomUUID } from 'node:crypto';
import { atomic, audit, db } from './store';
import { HttpError } from './security';
import type { AgentRun } from '../shared/src';
export type RunningStage = 'checking_permissions' | 'evaluating_fit' | 'exchanging_context' | 'rechecking_permissions';
const leaseMs = 15 * 60000;
async function expireRuns(userId: string): Promise<void> {
    const now = new Date().toISOString();
    await db().prepare("UPDATE agent_runs SET status='interrupted',stage='interrupted',updated_at=? WHERE user_id=? AND status='running' AND expires_at<=?").run(now, userId, now);
}
export async function agentRuns(userId: string): Promise<AgentRun[]> {
    await expireRuns(userId);
    const rows = await db().prepare('SELECT * FROM agent_runs WHERE user_id=? ORDER BY rowid DESC LIMIT 20').all(userId) as {
        id: string;
        kind: 'proposal';
        status: AgentRun['status'];
        stage: AgentRun['stage'];
        started_at: string;
        updated_at: string;
        expires_at: string;
        proposal_id: string | null;
    }[];
    return rows.map(row => ({ id: row.id, kind: row.kind, status: row.status, stage: row.stage,
        startedAt: row.started_at, updatedAt: row.updated_at, expiresAt: row.expires_at,
        ...(row.proposal_id ? { proposalId: row.proposal_id } : {}) }));
}
/** Track a real bounded request, not an always-running autonomous process. */
export async function withAgentRun<T extends {
    id: string | null;
}>(userId: string, work: (stage: (value: RunningStage) => void | Promise<void>) => Promise<T>): Promise<T> {
    const id = randomUUID(), now = new Date().toISOString();
    await atomic(async () => {
        await expireRuns(userId);
        if (await db().prepare("SELECT id FROM agent_runs WHERE user_id=? AND status='running'").get(userId)) {
            throw new HttpError(409, 'AGENT_BUSY', 'Your agent is already exploring a candidate. Check its activity before starting another request.');
        }
        await db().prepare("INSERT INTO agent_runs(id,user_id,kind,status,stage,started_at,updated_at,expires_at) VALUES(?,?,'proposal','running','checking_permissions',?,?,?)")
            .run(id, userId, now, now, new Date(Date.now() + leaseMs).toISOString());
        await audit(userId, 'agent_run', 'started', 'Owner requested a bounded candidate evaluation and permissioned exchange.');
    });
    const stage = async (value: RunningStage) => {
        const current = new Date().toISOString();
        const updated = await db().prepare("UPDATE agent_runs SET stage=?,updated_at=?,expires_at=? WHERE id=? AND user_id=? AND status='running' AND expires_at>?")
            .run(value, current, new Date(Date.now() + leaseMs).toISOString(), id, userId, current);
        if (updated.changes !== 1)
            throw new HttpError(409, 'AGENT_RUN_INTERRUPTED', 'This agent request is no longer active. Review activity before retrying.');
    };
    try {
        const result = await work(stage);
        await expireRuns(userId);
        const current = new Date().toISOString();
        const completed = await db().prepare("UPDATE agent_runs SET status='completed',stage='completed',updated_at=?,proposal_id=? WHERE id=? AND user_id=? AND status='running' AND expires_at>?")
            .run(current, result.id, id, userId, current);
        if (completed.changes !== 1)
            throw new HttpError(409, 'AGENT_RUN_INTERRUPTED', 'This agent request was interrupted. Refresh activity before retrying.');
        await audit(userId, 'agent_run', 'completed', 'The requested evaluation completed. Any candidate proposal remains subject to both human decisions.');
        return result;
    }
    catch (error) {
        await expireRuns(userId);
        await db().prepare("UPDATE agent_runs SET status='failed',stage='failed',updated_at=? WHERE id=? AND user_id=? AND status='running'")
            .run(new Date().toISOString(), id, userId);
        if (await db().prepare('SELECT id FROM users WHERE id=?').get(userId))
            await audit(userId, 'agent_run', 'failed', 'The requested agent evaluation did not complete. Review the request error before retrying.');
        throw error;
    }
}
