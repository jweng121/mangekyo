import { CompanionWorkspace } from "../../../CompanionWorkspace";
export default async function Review({params}:{params:Promise<{runId:string}>}) { const {runId}=await params;return <CompanionWorkspace platformRunId={runId}/>; }
