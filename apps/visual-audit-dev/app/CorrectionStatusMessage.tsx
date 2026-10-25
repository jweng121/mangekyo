import { Send, GitBranch, Brain, Check } from "lucide-react";

export function CorrectionStatusMessage({ kind, agent = "Monitored agent", context }: { kind: "sent" | "completed" | "memory" | "resolved"; agent?: string; context?: string }) {
  const copy = {
    sent: ["Correction sent", `Sent to ${agent}`],
    completed: ["Corrected run completed", `${agent} reran the affected work`],
    memory: ["Context saved to agent memory", `Saved for ${agent}${context ? ` / ${context}` : ""}`],
    resolved: ["Marked as resolved", `${context ?? "Case"} approved / ${agent}`],
  }[kind];
  const Icon = { sent: Send, completed: GitBranch, memory: Brain, resolved: Check }[kind];
  return <div className={`review-confirmation ${kind}`} role="status"><span className={`review-confirmation-icon ${kind}`} aria-hidden="true"><Icon size={16}/></span><span><strong>{copy[0]}</strong><small>{copy[1]}</small></span></div>;
}
