import { createPublicClient, getAddress, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { boundedFundingEnvelope } from '../ens/funding-envelope';
import { createEnsReadTransport } from '../ens/rpc-transport';
import type { PreparedEnsTransaction } from '../ens';
import { HttpError } from './security';

const maximumFeeWei=500000000000000n,maximumGasPriceWei=500000000n;
export function parseEnsFeeCap(value:string):bigint {
  if(!/^[1-9][0-9]{0,14}$/.test(value)||BigInt(value)>maximumFeeWei)throw new HttpError(400,'ENS_FEE_CAP_INVALID','Choose a positive maximum fee of at most 0.0005 Sepolia test ETH.');
  return BigInt(value);
}
/** A real estimate sets gas. The explicit owner budget and price ceiling bound the wallet request. */
export function boundedEnsFeeQuote(input:{estimatedGas:bigint;baseFeePerGas:bigint;maxFeeWei:string}){
  const cap=parseEnsFeeCap(input.maxFeeWei);
  if(input.estimatedGas<=0n||input.baseFeePerGas<0n)throw new HttpError(503,'ENS_FEE_QUOTE_INVALID','A valid current gas estimate is required.');
  try {
    const envelope=boundedFundingEnvelope({estimatedGas:input.estimatedGas,maxGasCostWei:cap,reviewedMaxFeePerGas:maximumGasPriceWei,reviewedMaxPriorityFeePerGas:10000000n,baseFeePerGas:input.baseFeePerGas});
    return {gas:(`0x${envelope.gas.toString(16)}`) as Hex,maxFeePerGas:(`0x${envelope.maxFeePerGas.toString(16)}`) as Hex,maxPriorityFeePerGas:(`0x${envelope.maxPriorityFeePerGas.toString(16)}`) as Hex,type:'0x2' as const,maxFeeWei:cap.toString(),quotedMaximumFeeWei:envelope.maxGasCostWei.toString()};
  } catch { throw new HttpError(409,'FEE_CAP_EXCEEDED','The current transaction does not fit the reviewed fee and priority limits. No wallet request was made.'); }
}
function readClient(){const rpcUrl=process.env.ENS_SEPOLIA_AUTH_RPC_URL||process.env.ENS_SEPOLIA_RPC_URL;if(!rpcUrl)throw new HttpError(503,'ENS_UNCONFIGURED','Configure the Sepolia read connection before preparing a transaction.');return createPublicClient({chain:sepolia,transport:createEnsReadTransport(rpcUrl)});}
async function close(client:ReturnType<typeof readClient>){try{const transport=client.transport as{getRpcClient?:()=>Promise<{close():void}>};if(transport.getRpcClient)(await transport.getRpcClient()).close();}catch{/* Preserve the result without exposing authenticated transport details. */}}
export async function quoteEnsTransactionFees(transaction:PreparedEnsTransaction,maxFeeWei:string){
  parseEnsFeeCap(maxFeeWei);
  if(transaction.chainId!==11155111||transaction.value!=='0x0')throw new HttpError(403,'ENS_FEE_SCOPE_DENIED','Only the reviewed zero-value Sepolia action can be quoted.');
  const client=readClient();try{
    const chainId=await client.getChainId(),head=await client.getBlock();
    if(chainId!==11155111||Math.abs(Date.now()/1000-Number(head.timestamp))>=90)throw new HttpError(503,'ENS_FEE_HEAD_UNAVAILABLE','A fresh Sepolia chain observation is required before wallet approval.');
    if(head.baseFeePerGas===null||head.baseFeePerGas===undefined)throw new HttpError(503,'ENS_FEE_HEAD_UNAVAILABLE','A current EIP-1559 base fee is required.');
    const estimatedGas=await client.estimateGas({account:getAddress(transaction.from),to:getAddress(transaction.to),data:transaction.data,value:0n});
    const quote=boundedEnsFeeQuote({estimatedGas,baseFeePerGas:head.baseFeePerGas,maxFeeWei});
    if(Math.abs(Date.now()/1000-Number(head.timestamp))>=90)throw new HttpError(503,'ENS_FEE_HEAD_UNAVAILABLE','Refresh the Sepolia fee observation before preparing another review.');
    return {...quote,expiresAt:new Date(Date.now()+10*60000).toISOString(),blockNumber:head.number.toString()};
  }finally{await close(client);}
}
export function assertEnsReceiptWithinFeeCap(receipt:{gasUsed:bigint;effectiveGasPrice:bigint},maxFeeWei:string){
  const cap=parseEnsFeeCap(maxFeeWei);
  if(receipt.gasUsed<=0n||receipt.effectiveGasPrice<0n||receipt.gasUsed*receipt.effectiveGasPrice>cap)throw new HttpError(409,'FEE_CAP_EXCEEDED','The actual transaction fee exceeds the recorded owner limit. No application confirmation was recorded.');
  return(receipt.gasUsed*receipt.effectiveGasPrice).toString();
}
export function assertEnsTransactionWithinFeeCap(transaction:{type?:string;gas:bigint;gasPrice?:bigint;maxFeePerGas?:bigint;maxPriorityFeePerGas?:bigint},maxFeeWei:string){
  const cap=parseEnsFeeCap(maxFeeWei),price=transaction.maxFeePerGas??transaction.gasPrice;
  if(transaction.type!=='eip1559'||transaction.maxPriorityFeePerGas===undefined||transaction.maxPriorityFeePerGas<0n||transaction.maxPriorityFeePerGas>10000000n||transaction.gas<=0n||price===undefined||price<=0n||price>maximumGasPriceWei||transaction.maxPriorityFeePerGas>price||transaction.gas*price>cap)throw new HttpError(409,'FEE_CAP_EXCEEDED','The actual signed transaction reserves more than the recorded owner fee limit.');
}
/** Receipt reconciliation stays available after quote expiry; it does not authorize another signature. */
export async function verifyEnsReceiptFee(hash:Hex,maxFeeWei:string,blockNumber:string){
  parseEnsFeeCap(maxFeeWei);const client=readClient();try{
    const [receipt,transaction]=await Promise.all([client.getTransactionReceipt({hash}),client.getTransaction({hash})]);
    if(receipt.status!=='success'||receipt.transactionHash.toLowerCase()!==hash.toLowerCase()||receipt.blockNumber.toString()!==blockNumber)throw new HttpError(409,'ENS_RECEIPT_CHANGED','The fee receipt does not agree with the confirmed transaction.');
    assertEnsTransactionWithinFeeCap(transaction,maxFeeWei);
    return assertEnsReceiptWithinFeeCap(receipt,maxFeeWei);
  }finally{await close(client);}
}
