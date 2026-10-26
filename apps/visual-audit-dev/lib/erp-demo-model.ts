export type DemoPhase = "disconnected" | "connecting" | "connected" | "receiving" | "auditing" | "escalated" | "failed";
export type DemoState = {phase:DemoPhase; sessionId:string; runIds:string[]; imported:number; step:string; escalationRunId?:string; error?:string;updatedAt?:string};
export type BankRow = {id:string;postedDate:string;description:string;amountCents:number;balanceCents:number;clientId:string|null;documentIds:string[];allocations?:{clientId:string;amountCents:number}[]};
export function checkSettlement(allocation:{amountCents:number;costCents:number}, agreement:{basis:string;rateBasisPoints:number;signed:boolean}, proposedFeeCents:number) {
  if(!agreement.signed || agreement.basis!=="net_after_costs")throw new Error("Expected a signed net-after-costs agreement");
  const feeCents=Math.round((allocation.amountCents-allocation.costCents)*agreement.rateBasisPoints/10000);
  return {feeCents,clientCents:allocation.amountCents-allocation.costCents-feeCents,excessCents:proposedFeeCents-feeCents};
}
export function ownerBalances(rows:BankRow[]) {
  const balances:Record<string,number>={};
  for(const row of rows)for(const allocation of row.allocations??(row.clientId?[{clientId:row.clientId,amountCents:row.amountCents}]:[]))balances[allocation.clientId]=(balances[allocation.clientId]??0)+allocation.amountCents;
  return balances;
}

export function initialImportBatches(rows:BankRow[]){
 const boundary=rows.findIndex(row=>row.id==="harborline-deposit");
 if(boundary<1)throw new Error("Settlement bank post missing");
 const groups=new Map<string,BankRow[]>();
 for(const row of rows.slice(0,boundary)){const month=row.postedDate.slice(0,7);groups.set(month,[...(groups.get(month)??[]),row]);}
 return [...groups].map(([month,transactions])=>({month,transactions}));
}
