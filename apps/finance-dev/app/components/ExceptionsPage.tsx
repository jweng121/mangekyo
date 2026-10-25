"use client";
import {useEffect,useState} from "react";
import Link from "next/link";
import {useQuery} from "convex/react";
import {Search, ArrowUpRight, GitBranch} from "lucide-react";
import {api} from "../../../../convex/_generated/api";
import "../mk.css";
export default function ExceptionsPage() {
 const accounts=useQuery(api.financeIntake.listAccounts);
 const [account,setAccount]=useState(""); const [query,setQuery]=useState(""); const [filter,setFilter]=useState("open");
 useEffect(()=>{try{setAccount(localStorage.getItem("mangekyo-platform-account")||"");}catch{}},[]);
 useEffect(()=>{if(account)try{localStorage.setItem("mangekyo-platform-account",account);}catch{}},[account]);
 const accountId=accounts?.some(a=>a.accountId===account)?account:(accounts?.map(a=>a.accountId).filter(id=>/^demo:account:pool-\d+$/.test(id)).sort().at(-1)??accounts?.[0]?.accountId);
 const desk=useQuery(api.financeDesk.getDeskData,accountId?{accountId}:"skip");
 const rows=(desk?.tasks??[]).filter(task=>task.latestRun).filter(task=>filter==="all"||["checker_rejected","failed","needs_information"].includes(task.latestRun!.status)).filter(task=>`${task.latestRun?.summary??""} ${task.latestRun?.status??""} ${task.bankSourceId??""}`.toLowerCase().includes(query.toLowerCase()));
 return <main className="mk platform-page"><header className="platform-page-header"><div><span className="eyebrow">Agent review</span><h1 style={{marginTop:8}}>Exceptions</h1></div><label className="field">Account<select aria-label="Exception account" value={accountId??""} onChange={e=>setAccount(e.target.value)}>{accounts?.map(a=><option key={a.accountId} value={a.accountId}>{a.name}</option>)}</select></label></header>
 <div className="platform-tabs" role="tablist" aria-label="Exception status"><button role="tab" aria-selected={filter==="open"} onClick={()=>setFilter("open")}>Needs escalation</button><button role="tab" aria-selected={filter==="all"} onClick={()=>setFilter("all")}>All runs</button></div>
 <label className="exception-search"><Search size={15}/><input aria-label="Search exceptions" placeholder="Search exceptions" value={query} onChange={e=>setQuery(e.target.value)}/></label>
 <div className="tbl"><table className="exception-table"><thead><tr><th>Investigation</th><th>Agent</th><th>Status</th><th>Updated</th><th><span className="sr">Open</span></th></tr></thead><tbody>{rows.map(task=>{const run=task.latestRun!;const flagged=["checker_rejected","failed","needs_information"].includes(run.status);return <tr key={task.taskId}><td><Link href={`/runs/${encodeURIComponent(run.runId)}`}><GitBranch size={15}/><span>{run.summary?.replace(/^SIMULATED: /,"").slice(0,105)||"Trust investigation"}<small>Attempt {run.attempt}</small></span></Link></td><td>Trust Intake</td><td><span className={`tag ${flagged?"t-bad":run.status==="completed"?"t-ok":"t-wait"}`}>{run.status==="checker_rejected"?"Unsupported evidence":run.status==="needs_information"?"Needs information":run.status.replaceAll("_"," ")}</span></td><td>{new Date(run.updatedAt).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</td><td><Link aria-label="Open investigation" href={`/runs/${encodeURIComponent(run.runId)}`}><ArrowUpRight size={16}/></Link></td></tr>;})}</tbody></table></div>
 {!rows.length&&<div className="platform-empty"><GitBranch size={26}/><h2>{desk===undefined&&accounts?.length?"Loading investigations":query?"No matching investigations":"No exceptions to review"}</h2><p>{query?"Try another search.":"Agent requests for review appear here."}</p><Link className="btn alt" href="/desk">Back to overview</Link></div>}
 </main>;
}
