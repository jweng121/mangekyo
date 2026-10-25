import type { Snapshot } from "../../../packages/contracts";
const agentName = (id: string) => id === "deposit-matching-agent" ? "Matching Agent" : id.replaceAll(/[-_]/g, " ");
export function annotationContext(snapshot: Snapshot, evidenceId: string, quote?: string) {
  const evidence = snapshot.evidence.find(item => item.id === evidenceId);
  const value = evidence?.value ?? quote;
  if (snapshot.actionType === "READ" && /^(Read|Searched|Opened)\b/.test(snapshot.summary)) return `${agentName(snapshot.agentId)} ${snapshot.summary.charAt(0).toLowerCase()}${snapshot.summary.slice(1)}`;
  const verb = snapshot.actionType === "READ" ? "read" : snapshot.actionType === "PROPOSE" ? "proposed" : "recorded";
  const label = (evidence?.label ?? snapshot.title).toLowerCase().replace(/^proposed /, "");
  return `${agentName(snapshot.agentId)} ${verb} ${label}${value ? `: ${value}` : "."}`;
}
