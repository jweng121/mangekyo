import type { AgentEvent, AuditFinding, Snapshot } from "@mangekyo/contracts";

export function answerMockQuestion(question: string, selected: Snapshot | undefined, events: AgentEvent[], findings: AuditFinding[]): string {
  if (!selected) return "Select a checkpoint to inspect its recorded evidence.";
  const lower = question.toLowerCase();
  const finding = findings.find(item => item.snapshotId === selected.id);
  if (/what changed|branch|corrected/.test(lower)) return events.some(event => event.id === "corrected-proposal") ? "The original maker proposed Client A. The simulated corrected branch revisits payment reference B-204 and proposes Client B. Neither branch posts a financial transaction." : "No corrected proposal is recorded yet. Review the flagged maker checkpoint and use the explicit Steer Agent control to create a simulated branch.";
  if (/memory|lesson|previous correction/.test(lower)) return selected.memoryRefs?.length ? `This checkpoint references approved memory ${selected.memoryRefs.join(", ")}. The simulated agent used it as guidance to investigate before allocation.` : "No approved memory reference is recorded at this checkpoint. Memory approval is separate from steering.";
  if (/why|disagree|conflict|mistake/.test(lower)) return finding?.explanation ?? `Recorded action: ${selected.summary} Evidence: ${selected.evidence.map(item => item.label).join(", ") || "none"}.`;
  if (/read|data|evidence|saw/.test(lower)) return `Recorded reads: ${selected.readTargets.join(", ") || "none"}. Sources: ${selected.evidence.map(item => `${item.label} (${item.value ?? item.source})`).join("; ") || selected.source}. This is a structured synthetic observation, not a browser screenshot.`;
  if (/steer|correct/.test(lower)) return "Use the dedicated Steer Agent control on the flagged maker proposal. Chat alone cannot submit a correction.";
  if (/agent|progress|doing/.test(lower)) return `${selected.agentRole} performed ${selected.actionType}: ${selected.summary} ${events.length} checkpoints are visible in this simulated timeline.`;
  return `${selected.agentRole} — ${selected.title}: ${selected.summary} Ask about evidence, disagreement, branches, or memory for more detail.`;
}
