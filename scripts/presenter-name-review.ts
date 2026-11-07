import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createPublicClient, encodeFunctionData, getAddress, keccak256, stringToHex, zeroAddress, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { ALL_ROLES, createEnsAuthorityProvider, ENS_CHAIN_ID, ENS_DEPLOYMENT, NAME_OWNER_ROLES } from '../packages/ens';
import { registryAbi } from '../packages/ens/abi';
import { boundedFundingEnvelope } from '../packages/ens/funding-envelope';
import { createEnsReadTransport } from '../packages/ens/rpc-transport';
import { db, closeStore } from '../packages/server/store';
import { decrypt } from '../packages/server/crypto';

// Only public consent fields and chain reads. No accounts, signing keys, writes or wallet clients.
const issuer=getAddress('0x9253705482a44e6A7378163e57cc791AE6213ed5');
const recipient=getAddress('0xEE291Bc0246441F53610FbCAF2bC892110e72732');
const branch='users.meeti-demo.eth',label='dk',userName=`${label}.${branch}`,agentName=`networking.${userName}`;
const cap=500000000000000n;
function assert(condition:unknown,reason:string):asserts condition{if(!condition)throw new Error(reason);}
function numericCodes(error:unknown){const codes:{httpStatus?:number;rpcCode?:number}[]=[];let item=error;for(let depth=0;depth<8&&item&&typeof item==='object';depth++){const value=item as {status?:unknown;code?:unknown;cause?:unknown};const httpStatus=typeof value.status==='number'?value.status:undefined,rpcCode=typeof value.code==='number'?value.code:undefined;if(httpStatus!==undefined||rpcCode!==undefined)codes.push({httpStatus,rpcCode});if(value.cause===item)break;item=value.cause;}return codes;}
let stage='configuration';
async function main(){
  assert(!existsSync('.local-data/presenter-name-approval.json'),'approved_presenter_review_is_immutable');
  assert(process.env.SUPABASE_DATABASE_URL,'hosted_database_read_required');
  process.env.DATABASE_PROVIDER='postgres';
  assert((process.env.ENS_PROJECT_PARENT||'meeti-demo.eth')==='meeti-demo.eth','configured_parent_mismatch');
  assert(process.env.ENS_PROJECT_ISSUER&&getAddress(process.env.ENS_PROJECT_ISSUER)===issuer,'configured_issuer_mismatch');
  const rpcUrl=process.env.ENS_SEPOLIA_AUTH_RPC_URL||process.env.ENS_SEPOLIA_RPC_URL;assert(rpcUrl,'ens_read_connection_required');
  const client=createPublicClient({chain:sepolia,transport:createEnsReadTransport(rpcUrl)}),ens=createEnsAuthorityProvider({rpcUrl});
  try{
    stage='claim_read';
    const row=await db().prepare('SELECT namespace_claims.id,namespace_claims.label,namespace_claims.version,namespace_claims.state,namespace_claims.data FROM namespace_claims JOIN users ON users.id=namespace_claims.user_id WHERE namespace_claims.label=? AND namespace_claims.recipient=? AND users.wallet=?').get(label,recipient.toLowerCase(),recipient.toLowerCase()) as {id:string;label:string;version:number;state:string;data:string}|undefined;
    assert(row&&row.state==='requested','presenter_unsigned_requested_claim_required');
    const approved=decrypt<{recipient:string;userName:string;agentName:string;publicApprovedAt:string}>(row.data,`namespace-claim:${row.id}`);
    assert(getAddress(approved.recipient)===recipient&&approved.userName===userName&&approved.agentName===agentName&&Number.isFinite(Date.parse(approved.publicApprovedAt)),'presenter_claim_public_consent_mismatch');
    stage='parent_read';
    const parent=await ens.inspectProjectParent({parentName:'meeti-demo.eth',issuer});
    const users=await ens.inspectProjectParent({parentName:branch,issuer});
    assert(parent.nextStep==='ready'&&users.nextStep==='ready','existing_namespace_structure_not_ready');
    stage='recipient_registry_read';
    const registry=await ens.prepareProjectRecipientRegistry({parentName:branch,label,issuer,recipient});
    const block=await client.getBlock();assert(await client.getChainId()===ENS_CHAIN_ID&&Math.abs(Date.now()/1000-Number(block.timestamp))<90,'wrong_chain_or_stale_head');
    const state=await client.readContract({address:users.subregistry,abi:registryAbi,functionName:'getState',args:[BigInt(keccak256(stringToHex(label)))],blockNumber:block.number});
    assert(state.status===0&&state.expiry===0n,'presenter_name_not_available');
    const expiresAt=Math.floor(Date.parse(users.expiresAt)/1000);
    const issuance={chainId:ENS_CHAIN_ID,from:issuer,to:users.subregistry,value:'0x0',operation:'issue-project-subname',ensName:userName,data:encodeFunctionData({abi:registryAbi,functionName:'register',args:[label,recipient,registry.predictedAddress,zeroAddress,NAME_OWNER_ROLES,BigInt(expiresAt)]})};
    stage='fee_and_code_reads';
    const balances=[];for(const [role,address]of[['issuer',issuer],['recipient',recipient]] as const)balances.push({role,address,balanceWei:(await client.getBalance({address,blockNumber:block.number})).toString()});
    const codeChecks=[];for(const [role,address]of Object.entries({rootRegistry:ENS_DEPLOYMENT.rootRegistry,factory:ENS_DEPLOYMENT.factory,registryImplementation:ENS_DEPLOYMENT.registryImplementation,usersRegistry:users.subregistry})){const code=await client.getCode({address,blockNumber:block.number});assert(code&&code!=='0x','required_contract_code_missing');codeChecks.push({role,address,codeHash:keccak256(code)});}
    const operations=[];
    async function quoted(transaction:{from:string;to:string;data:Hex;value:string;operation:string;ensName:string},id:string){const estimatedGas=await client.estimateGas({account:getAddress(transaction.from),to:getAddress(transaction.to),data:transaction.data,value:0n});const envelope=boundedFundingEnvelope({estimatedGas,maxGasCostWei:cap,reviewedMaxFeePerGas:500000000n,reviewedMaxPriorityFeePerGas:10000000n,baseFeePerGas:block.baseFeePerGas??0n});return{id,...transaction,estimatedGas:estimatedGas.toString(),gasLimit:envelope.gas.toString(),maxFeePerGas:envelope.maxFeePerGas.toString(),maxPriorityFeePerGas:envelope.maxPriorityFeePerGas.toString(),maxGasCostWei:cap.toString(),simulation:'actual_current_state_call_and_estimate'};}
    if(registry.needed){operations.push({...await quoted(registry,'presenter-recipient-registry'),dependsOn:[],predictedAddress:registry.predictedAddress,expectedRootOwner:recipient,expectedRootRoles:ALL_ROLES.toString(),expectedIssuerRootRoles:'0'});operations.push({id:'presenter-user-issuance',...issuance,dependsOn:['presenter-recipient-registry'],gasLimit:'1000000',maxFeePerGas:'500000000',maxPriorityFeePerGas:'10000000',maxGasCostWei:cap.toString(),simulation:'not_simulated_until_recipient_registry_confirmed',requiredPreflight:'Reprepare through prepareProjectSubname, verify recipient-only registry roles, current label availability and exact calldata, then estimate within the unchanged money cap.'});}
    else{const actual=await ens.prepareProjectSubname({parentName:branch,label,issuer,recipient,expiresAt,recipientSubregistry:registry.predictedAddress});assert(actual.data===issuance.data&&actual.to.toLowerCase()===issuance.to.toLowerCase(),'issuance_adapter_calldata_mismatch');operations.push({...await quoted(actual,'presenter-user-issuance'),dependsOn:[]});}
    const maximumIssuerGasWei=(cap*BigInt(operations.length)).toString();
    const recipientBalance=BigInt(balances.find(value=>value.role==='recipient')!.balanceWei),ownerGasCap=4500000000000000n;
    const report={reviewOnly:true,approvalState:'NOT_AUTHORIZED',network:'Ethereum Sepolia',chainId:ENS_CHAIN_ID,checkedAt:new Date().toISOString(),reviewExpiresAt:new Date(Date.now()+2*3600000).toISOString(),blockNumber:block.number.toString(),blockHash:block.hash,claim:{id:row.id,version:row.version,state:row.state,publicApprovedAt:approved.publicApprovedAt},issuer,recipient,userName,agentName,agentExists:false,parent,users,recipientRegistry:registry.predictedAddress,recipientRegistryAlreadyConfirmed:!registry.needed,codeChecks,balances,operations,maximumIssuerGasWei,issuerCurrentlyFunded:BigInt(balances[0].balanceWei)>=BigInt(maximumIssuerGasWei),nativeTransferValueWei:'0',excluded:['No recipient funding transfer.','No personal-wallet signature or private key access.','No agent child, resolver, policy, delegate or ERC-8004 transaction.','No new branch, replacement parent, World verification or invitation.'],retainedPowers:'The recipient alone receives all root roles in its dedicated registry and owns the dk user-name token. The issuer retains its existing ancestor powers on meeti-demo.eth and users.meeti-demo.eth. The user token is not emancipated.',ownerFollowUp:{requiresPersonalWalletApproval:true,agentTransactions:['create-subname','deploy-resolver','set-resolver','set-policy','grant'],optionalPublicIdentityTransactions:['register-identity','publish-context','set-identity-uri','attest-association'],perTransactionGasCapWei:cap.toString(),fiveAgentTransactionGasCapWei:(5n*cap).toString(),fourIdentityTransactionGasCapWei:(4n*cap).toString(),totalOwnerGasCapWei:ownerGasCap.toString(),conditionalFundingGapWei:(recipientBalance>=ownerGasCap?0n:ownerGasCap-recipientBalance).toString(),fundingIncluded:false,separateDelegateRequired:true,delegateKeyCreated:false},signaturesRequested:0,transactionsSubmitted:0};
    const encoded=JSON.stringify(report,null,2),reviewSha256=createHash('sha256').update(encoded).digest('hex');mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/presenter-name-review.json',encoded,{flag:'wx',mode:0o600});
    console.log(JSON.stringify({path:'artifacts/presenter-name-review.json',reviewSha256,checkedAt:report.checkedAt,blockNumber:report.blockNumber,claimState:row.state,operations:operations.map(value=>({id:value.id,operation:value.operation})),recipientRegistry:registry.predictedAddress,maximumIssuerGasWei,issuerCurrentlyFunded:report.issuerCurrentlyFunded,recipientBalanceWei:recipientBalance.toString(),ownerGasCapWei:ownerGasCap.toString(),conditionalOwnerFundingGapWei:report.ownerFollowUp.conditionalFundingGapWei,signatures:0,broadcasts:0}));
  }finally{await ens.disconnect();try{const transport=client.transport as {getRpcClient?:()=>Promise<{close():void}>};if(transport.getRpcClient)(await transport.getRpcClient()).close();}catch{/* Do not reveal authenticated transport details. */}}
}
main().catch(error=>{console.error(JSON.stringify({ok:false,stage,code:'PRESENTER_UNSIGNED_REVIEW_NOT_COMPLETE',numericCodes:numericCodes(error),signatures:0,broadcasts:0}));process.exitCode=1;}).finally(()=>closeStore());
