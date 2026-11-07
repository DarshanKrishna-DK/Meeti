import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agent, atomic, audit, db, intent, profile } from './store';
import { decrypt, encrypt, hash } from './crypto';
import { assertIntent, authority, policyDigest } from './policy';
import { HttpError, rateLimit, requireValue } from './security';
import { discoverCandidates, freshPublicIntent } from './discovery';
import { enqueueAgentTask, readAgentTask, cancelAgentTask } from './agent-tasks';
import type { Agent, Intent } from '../shared/src';

const statuses=z.enum(['queued','searching','qualifying','completed','no_candidates','blocked','cancelled','expired','interrupted']);
const payloadSchema=z.object({version:z.literal(1),approved:z.literal(true),approvedAt:z.string().datetime(),sessionHash:z.string().regex(/^[a-f0-9]{64}$/),wallet:z.string().regex(/^0x[a-f0-9]{40}$/),intentDigest:z.string().regex(/^[a-f0-9]{64}$/),policyDigest:z.string(),agentDigest:z.string().regex(/^[a-f0-9]{64}$/),includeDemo:z.boolean(),candidates:z.array(z.object({key:z.string().regex(/^0x[a-f0-9]{64}$/),owner:z.string().regex(/^0x[a-f0-9]{40}$/)}).strict()).max(2),taskIds:z.array(z.string().uuid()).max(2),coverage:z.object({scannedCandidates:z.number().int().min(0).max(4),candidateLimit:z.literal(4),truncated:z.boolean()}).strict().optional(),failureCode:z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional()}).strict();
type Payload=z.infer<typeof payloadSchema>;
type Row={id:string;user_id:string;intent_id:string;intent_version:number;entity_key:string;status:z.infer<typeof statuses>;data:string;lease_token:string|null;lease_until:string|null;created_at:string;updated_at:string;expires_at:string};
export type AutoQualificationDto={batchId:string;intentId:string;intentVersion:number;status:Row['status'];selectedCount:number;maximumCandidates:2;taskIds:string[];candidateKeys:string[];coverage?:Payload['coverage'];failureCode?:string;updatedAt:string;expiresAt:string};
function agentDigest(value:Agent){return hash(JSON.stringify([value.id,value.owner.toLowerCase(),value.delegate.toLowerCase(),value.ensName,value.config.resolverAddress,policyDigest(value.policy)]));}
const active=['queued','searching','qualifying'],leaseMs=6*60000;
function decode(row:Row){statuses.parse(row.status);return payloadSchema.parse(decrypt(row.data,`auto-qualification:${row.user_id}:${row.id}`));}
function dto(row:Row):AutoQualificationDto{const value=decode(row);return{batchId:row.id,intentId:row.intent_id,intentVersion:row.intent_version,status:row.status,selectedCount:value.candidates.length,maximumCandidates:2,taskIds:value.taskIds,candidateKeys:value.candidates.map(candidate=>candidate.key),coverage:value.coverage,failureCode:value.failureCode,updatedAt:row.updated_at,expiresAt:row.expires_at};}
async function owned(userId:string,id:string){z.string().uuid().parse(id);return requireValue(await db().prepare('SELECT * FROM auto_qualification_batches WHERE id=? AND user_id=?').get(id,userId) as Row|undefined,'Automatic qualification request was not found.',404);}
async function session(row:Row,value:Payload){
  const owner=await db().prepare('SELECT users.wallet FROM users JOIN sessions ON sessions.user_id=users.id WHERE users.id=? AND sessions.token_hash=? AND sessions.expires_at>?').get(row.user_id,value.sessionHash,new Date().toISOString()) as {wallet:string|null}|undefined;
  if(!owner||owner.wallet?.toLowerCase()!==value.wallet)throw new HttpError(401,'AUTO_SESSION_CLOSED','The session that approved automatic qualification is no longer active.');
}
async function current(row:Row,value:Payload){
  await session(row,value);
  if(Date.parse(row.expires_at)<=Date.now())throw new HttpError(409,'AUTO_EXPIRED','This bounded automatic qualification request expired.');
  const own=await intent(row.intent_id),a=await agent(row.user_id);
  if(!own||own.userId!==row.user_id||own.value.version!==row.intent_version||own.value.arkivKey?.toLowerCase()!==row.entity_key||hash(JSON.stringify(own.value))!==value.intentDigest)throw new HttpError(409,'AUTO_INTENT_CHANGED','The reviewed public intent changed.');
  assertIntent(own.value);
  if(!a||a.policy.paused||Date.parse(a.policy.expiresAt)<=Date.now()||policyDigest(a.policy)!==value.policyDigest||agentDigest(a)!==value.agentDigest||!(['discover','evaluate','negotiate','introduce'] as const).every(action=>a.policy.allowedActions.includes(action))||!(await profile(row.user_id)).aiConsent)throw new HttpError(403,'AUTO_PERMISSION_REQUIRED','Current permissions and provider consent are required.');
  return own.value;
}
/** Consent is private and bound to an already confirmed public revision. This does not call a provider. */
export async function requestAutoQualification(userId:string,sessionHash:string,value:Intent,input:{approved:true;includeDemo:boolean}){
  z.string().regex(/^[a-f0-9]{64}$/).parse(sessionHash);z.literal(true).parse(input.approved);
  return atomic(async()=>{
    const own=await intent(value.id);if(!own||own.userId!==userId||hash(JSON.stringify(own.value))!==hash(JSON.stringify(value)))throw new HttpError(409,'AUTO_INTENT_CHANGED','Confirm the current public intent before requesting automatic qualification.');
    assertIntent(value);const key=requireValue(value.arkivKey,'A confirmed Arkiv publication is required.').toLowerCase();
    if(!value.transactionHash)throw new HttpError(409,'AUTO_PUBLICATION_REQUIRED','Confirm the actual publication receipt first.');
    const prior=await db().prepare('SELECT * FROM auto_qualification_batches WHERE user_id=? AND intent_id=? AND intent_version=? AND entity_key=?').get(userId,value.id,value.version,key) as Row|undefined;
    if(prior)return dto(prior);
    const a=requireValue(await agent(userId),'Set up your agent.'),now=new Date().toISOString(),id=randomUUID();
    const payload:Payload={version:1,approved:true,approvedAt:now,sessionHash,wallet:a.owner.toLowerCase(),intentDigest:hash(JSON.stringify(value)),policyDigest:policyDigest(a.policy),agentDigest:agentDigest(a),includeDemo:input.includeDemo,candidates:[],taskIds:[]};
    const row:Row={id,user_id:userId,intent_id:value.id,intent_version:value.version,entity_key:key,status:'queued',data:'',lease_token:null,lease_until:null,created_at:now,updated_at:now,expires_at:new Date(Math.min(Date.now()+3600000,Date.parse(value.expiresAt))).toISOString()};
    try{await current(row,payload);if(process.env.AGENT_TASK_QUEUE_ENABLED!=='true')throw new HttpError(503,'AUTO_QUEUE_UNAVAILABLE','The bounded agent task worker is not enabled.');}catch(error){row.status='blocked';payload.failureCode=error instanceof HttpError?error.code:'AUTO_PERMISSION_REQUIRED';}
    if(await db().prepare("SELECT id FROM auto_qualification_batches WHERE user_id=? AND status IN ('queued','searching','qualifying')").get(userId)){row.status='blocked';payload.failureCode='AUTO_BATCH_BUSY';}
    row.data=encrypt(payload,`auto-qualification:${userId}:${id}`);
    await db().prepare('INSERT INTO auto_qualification_batches(id,user_id,intent_id,intent_version,entity_key,status,data,lease_token,lease_until,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,userId,value.id,value.version,key,row.status,row.data,null,null,now,now,row.expires_at);
    await audit(userId,'auto_qualification',row.status,'Owner approved one discovery scan and at most two distinct eligible counterparts for this confirmed intent revision.');return dto(row);
  });
}
async function fenceExpired(snapshot:Row):Promise<Row>{return atomic(async()=>{const row=await owned(snapshot.user_id,snapshot.id);
  if(!active.includes(row.status))return row;
  const expired=Date.parse(row.expires_at)<=Date.now(),lost=Boolean(row.lease_token&&row.lease_until&&Date.parse(row.lease_until)<=Date.now());
  if(!expired&&!lost)return row;
  const value=decode(row),status=expired?'expired':'interrupted';
  value.failureCode=expired?'AUTO_EXPIRED':'AUTO_INTERRUPTED';
  await atomic(async()=>{await db().prepare('UPDATE auto_qualification_batches SET status=?,data=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status=?').run(status,encrypt(value,`auto-qualification:${row.user_id}:${row.id}`),new Date().toISOString(),row.id,row.status);for(const taskId of value.taskIds)await cancelAgentTask(row.user_id,taskId);});
  return owned(row.user_id,row.id);
});}
export async function listAutoQualifications(userId:string){const rows=await db().prepare('SELECT * FROM auto_qualification_batches WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 10').all(userId) as Row[];const values=[];for(const row of rows)values.push(dto(await fenceExpired(row)));return values;}
export async function cancelAutoQualification(userId:string,id:string){return atomic(async()=>{const row=await owned(userId,id);if(!active.includes(row.status))return dto(row);const value=decode(row);for(const taskId of value.taskIds)await cancelAgentTask(userId,taskId);await db().prepare("UPDATE auto_qualification_batches SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),id);await audit(userId,'auto_qualification','cancelled','Owner stopped the batch and fenced its unfinished task. Previously completed exchanges remain in history.');return dto(await owned(userId,id));});}
/** One stage per authenticated continuation. Provider calls stay outside SQL transactions. */
export async function advanceAutoQualification(userId:string,id:string){
  const token=randomUUID();
  const claimed=await atomic(async()=>{const row=await fenceExpired(await owned(userId,id));if(!active.includes(row.status)||row.lease_token)return null;decode(row);await db().prepare('UPDATE auto_qualification_batches SET lease_token=?,lease_until=?,updated_at=? WHERE id=? AND lease_token IS NULL').run(token,new Date(Date.now()+leaseMs).toISOString(),new Date().toISOString(),id);return row;});
  if(!claimed)return null;
  let value=decode(claimed);
  const assertLease=async()=>{const latest=await owned(userId,id);if(latest.lease_token!==token||!active.includes(latest.status)||!latest.lease_until||Date.parse(latest.lease_until)<=Date.now())throw new HttpError(409,'AUTO_LEASE_LOST','Automatic qualification no longer has permission to continue.');await current(latest,value);return latest;};
  const save=async(status:Row['status'])=>{await assertLease();await db().prepare('UPDATE auto_qualification_batches SET status=?,data=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?').run(status,encrypt(value,`auto-qualification:${userId}:${id}`),new Date().toISOString(),id,token);};
  try{
    const own=await current(claimed,value);
    if(claimed.status==='queued'){
      await authority(userId,'negotiate',own.policyVersion);
      await db().prepare("UPDATE auto_qualification_batches SET status='searching' WHERE id=? AND lease_token=?").run(id,token);
      const result=await discoverCandidates(userId,own,{includeDemo:value.includeDemo,maximumCandidates:4});
      await assertLease();const owners=new Set<string>();
      value={...value,...(result.coverage?{coverage:{scannedCandidates:result.coverage.scannedCandidates,candidateLimit:4 as const,truncated:result.coverage.truncated}}:{}),candidates:result.candidates.filter(candidate=>{const owner=candidate.owner.toLowerCase();if(!candidate.match.eligible||owner===value.wallet||owners.has(owner))return false;owners.add(owner);return true;}).slice(0,2).map(candidate=>({key:candidate.key.toLowerCase(),owner:candidate.owner.toLowerCase()}))};
      await atomic(async()=>{await save(value.candidates.length?'qualifying':'no_candidates');await audit(userId,'auto_qualification',value.candidates.length?'candidates_selected':'no_candidates',`${value.candidates.length} distinct eligible owners selected from one bounded Arkiv scan. No conversation outcome has been assumed.`);});
      return dto(await owned(userId,id));
    }
    if(value.taskIds.length){const latest=await readAgentTask(userId,value.taskIds[value.taskIds.length-1]);if(['queued','running'].includes(latest.status)){await atomic(()=>save('qualifying'));return dto(await owned(userId,id));}if(latest.status!=='completed')throw new HttpError(409,'AUTO_TASK_STOPPED','The previous candidate task stopped. Automatic qualification will not retry it.');}
    if(value.taskIds.length>=value.candidates.length){await atomic(()=>save('completed'));return dto(await owned(userId,id));}
    const candidate=value.candidates[value.taskIds.length];
    // Re-read the exact candidate through Arkiv before queueing. The task independently rechecks both identities and permissions.
    const {arkiv}=await import('./policy');const fresh=await arkiv().readActive(candidate.key);if(fresh.owner.toLowerCase()!==candidate.owner)throw new HttpError(409,'AUTO_CANDIDATE_CHANGED','The candidate owner changed.');
    const linked=await intent(fresh.intent.intentId);if(!linked||linked.userId===userId||linked.value.arkivKey?.toLowerCase()!==candidate.key)throw new HttpError(409,'AUTO_CANDIDATE_CHANGED','The candidate inbox changed.');
    await freshPublicIntent(linked.userId,linked.value,'negotiate');
    await authority(userId,'negotiate',own.policyVersion);
    await atomic(async()=>{await assertLease();const queued=await enqueueAgentTask(userId,value.sessionHash,'propose',{intentId:own.id,candidateKey:candidate.key},()=>rateLimit('evaluate:'+userId,4,3600000));value={...value,taskIds:[...value.taskIds,queued.taskId]};await save('qualifying');});
    return dto(await owned(userId,id));
  }catch(error){const code=error instanceof HttpError?error.code:'AUTO_PROVIDER_UNAVAILABLE';await atomic(async()=>{const latest=await owned(userId,id);if(latest.lease_token!==token||!active.includes(latest.status))return;value={...value,failureCode:code};await db().prepare("UPDATE auto_qualification_batches SET status='blocked',data=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?").run(encrypt(value,`auto-qualification:${userId}:${id}`),new Date().toISOString(),id,token);await audit(userId,'auto_qualification','blocked','Automatic qualification stopped. Review current activity before an explicit new action.');});return dto(await owned(userId,id));}
}
