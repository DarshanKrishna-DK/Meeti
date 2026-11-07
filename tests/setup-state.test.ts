import { describe, expect, it } from 'vitest';
import type { AppState } from '../packages/shared/src';
import { confirmedName, nameRequestStatus, nextSetupAction, type NameClaim } from '../components/setup-state';

const now=Date.parse('2026-11-07T10:00:00Z');
const claim={id:'fixture-claim',version:1,label:'fixture',state:'requested',recipient:'0x1111111111111111111111111111111111111111',userName:'fixture.users.example.eth',agentName:'networking.fixture.users.example.eth',agentConfirmed:false,receipts:[]} satisfies NameClaim;
function state(extra:Record<string,unknown>={}) {return {profile:{displayName:'Fixture',seeking:'A collaborator',offering:'Design'},agent:null,intents:[],proposals:[],agentTasks:[],...extra} as unknown as AppState;}
const policy={paused:false,expiresAt:'2026-11-08T10:00:00Z'};
const liveIntent={status:'published',publicStatus:'active',expiresAt:'2026-11-08T10:00:00Z',arkivKey:'entity-fixture',transactionHash:'tx-fixture'};
describe('setup navigation hints with fixtures, never authorization',()=>{
  it('keeps requests and prepared reviews distinct from confirmed issuance',()=>{
    expect(confirmedName(claim)).toBe(false);
    expect(nameRequestStatus(claim).label).toBe('Request received');
    expect(nameRequestStatus({...claim,state:'prepared'}).label).toBe('Review prepared');
    expect(confirmedName({...claim,state:'confirmed'})).toBe(false);
    expect(confirmedName({...claim,state:'confirmed',receipts:[{operation:'deploy-registry',hash:'fixture',blockNumber:'1'}]})).toBe(false);
    expect(confirmedName({...claim,state:'confirmed',receipts:[{operation:'issue-project-subname',hash:'fixture',blockNumber:'1'}]})).toBe(true);
  });
  it('continues to agent setup only after actual issuance evidence',()=>{
    expect(nextSetupAction(state(),claim,now).label).toBe('Check your name request');
    expect(nextSetupAction(state(),{...claim,state:'confirmed',receipts:[{operation:'issue-project-subname',hash:'fixture',blockNumber:'1'}]},now).label).toBe('Set up your agent');
  });
  it.each([{allowed:false,policy},{allowed:true,policy:{...policy,paused:true}},{allowed:true,policy:{...policy,expiresAt:'2026-11-06T10:00:00Z'}}])('keeps saved, denied, paused or expired agents at permissions (%j)',({allowed,policy})=>{
    expect(nextSetupAction(state({agent:{authority:{allowed},policy},intents:[liveIntent]}),null,now).label).toBe('Check agent permissions');
  });
  it('does not send expired or closed public records to discovery',()=>{
    const agent={authority:{allowed:true},policy};
    for(const intent of [{...liveIntent,publicStatus:'closed'},{...liveIntent,expiresAt:'2026-11-06T10:00:00Z'},{...liveIntent,transactionHash:null}])expect(nextSetupAction(state({agent,intents:[intent]}),null,now).label).toBe('Write your intention');
    expect(nextSetupAction(state({agent,intents:[liveIntent]}),null,now).label).toBe('Find connections');
  });
});
