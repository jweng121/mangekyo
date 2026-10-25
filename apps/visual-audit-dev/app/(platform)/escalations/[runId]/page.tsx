import {CompanionWorkspace} from "../../../CompanionWorkspace";
export default async function Page({params}:{params:Promise<{runId:string}>}){const {runId}=await params;return <CompanionWorkspace key={runId} initialRunId={runId}/>;}
