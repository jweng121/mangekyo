import { personName } from "./desk";

/** Orchestrator states in words; tone is never the only signal. */
export const STATE: Record<string, { label: string; tone: "t-ok" | "t-bad" | "t-wait" | "t-ai" | "t-code" }> = {
  received: { label: "Received", tone: "t-code" },
  investigating: { label: "Investigating", tone: "t-ai" },
  validating: { label: "Validating the answer", tone: "t-code" },
  checking: { label: "Checking every claim", tone: "t-ai" },
  needs_person: { label: "Needs a person", tone: "t-wait" },
  ready_for_approval: { label: "Ready for approval", tone: "t-ok" },
  rejected: { label: "Rejected by the checker", tone: "t-bad" },
  waiting_to_clear: { label: "Waiting to clear", tone: "t-wait" },
  failed: { label: "Failed, needs a person", tone: "t-bad" },
};

const TRIGGER: Record<string, string> = {
  deposit_received: "the deposit arrived", auto_start: "auto-start", person_started: "a person started it", person_answered: "a person answered",
  person_corrected: "a person corrected it", deposit_cleared: "the deposit cleared", mismatch_found: "the three-way check failed", budget_refused: "the real-run budget",
  provider_result: "the agent answered", provider_error: "provider or network trouble", timeout: "timeout", validated: "validation passed", validation_failed: "validation failed",
  checker_result: "the checker's verdict", checker_failed: "the checker failed", person_approved_correction: "a person approved the entry", person_rejected_correction: "a person rejected the entry",
};
export const triggerWords = (trigger: string) => TRIGGER[trigger] ?? trigger.replace(/_/g, " ");

export function actorWords(actor: { type: string; identity: string }): string {
  if (actor.type === "person") return personName(actor.identity);
  if (actor.type === "code") return "Code";
  if (actor.type === "system") return "Orchestrator";
  if (actor.identity.startsWith("agent:claim-checker")) return `Agent 2 · checker (${actor.identity.split(":").at(-1)})`;
  if (actor.identity.startsWith("agent:reconciler")) return "Mismatch agent (mock)";
  return `Investigator (${actor.identity.split(":").at(-1)})`;
}

export interface TimelineEvent {
  eventId: string; sequence: number; kind: "transition" | "retry" | "budget_check"; from: string | null; to: string; trigger: string;
  actor: { type: string; identity: string }; reason: { code: string; message: string }; timestamp: number; snapshotId: string | null; runId: string | null;
  budget?: { allowed: boolean; usedToday: number; usedForDeposit: number; needed: number; limits: { perDay: number; perDeposit: number } }; error?: { code: string; message: string };
}

/** One line per saved orchestrator event. */
export function eventTitle(e: TimelineEvent): string {
  if (e.kind === "retry") return "Retried once automatically";
  if (e.kind === "budget_check") return e.budget?.allowed === false ? "Budget check: refused" : e.budget?.needed ? `Budget check: allowed (${e.budget.needed} real run${e.budget.needed === 1 ? "" : "s"})` : "Budget check: mock, doesn't count";
  if (e.from === null) return `${STATE[e.to]?.label ?? e.to}`;
  if (e.from === e.to) return `${STATE[e.to]?.label ?? e.to} · ${triggerWords(e.trigger)}`;
  return `${STATE[e.from]?.label ?? e.from} → ${STATE[e.to]?.label ?? e.to}`;
}
