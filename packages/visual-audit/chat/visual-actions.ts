import type { InvestigationRecord, Snapshot } from "@mangekyo/contracts";

export type VisualAction =
  | { kind: "focus_snapshot"; snapshotId: string; evidenceIds: string[] }
  | { kind: "compare_evidence"; snapshotIds: [string, string] }
  | { kind: "previous" | "next" | "walkthrough" | "steer" | "open_original" };

/** Resolve UI actions only from persisted evidence. Never accept model-generated coordinates. */
export function visualActionsForQuestion(question: string, selected: Snapshot, record: InvestigationRecord, citedIds: string[] = []): VisualAction[] {
  const snapshots = record.snapshots.filter(item => item.runId === selected.runId).sort((a, b) => a.sequence - b.sequence);
  const q = question.toLowerCase();
  if (/previous|preceding|before this/.test(q)) return [{ kind: "previous" }];
  if (/next|after this/.test(q)) return [{ kind: "next" }];
  if (/steer|correct the agent|redirect/.test(q)) return [{ kind: "steer" }];
  if (/original (document|capture|screenshot)/.test(q)) return [{ kind: "open_original" }];
  if (/walk (me )?through|how did .*happen|explain the sequence/.test(q)) return [{ kind: "walkthrough" }];
  if (/compare|disagree|conflict/.test(q)) {
    const bank = snapshots.find(item => /bank|payment reference/i.test(item.title));
    const invoice = snapshots.find(item => /invoice/i.test(item.title));
    if (bank && invoice) return [{ kind: "compare_evidence", snapshotIds: [bank.id, invoice.id] }];
  }
  const specific = /bank|statement|payment reference/.test(q) ? /bank|payment reference/i
    : /invoice|client a/.test(q) ? /invoice|owner allocation/i
    : /customer|company|client b/.test(q) ? /customer|payment code/i : undefined;
  const target = (specific ? snapshots.find(item => specific.test(item.title)) : undefined)
    ?? citedIds.map(id => snapshots.find(item => item.id === id)).find((item): item is Snapshot => !!item);
  return target ? [{ kind: "focus_snapshot", snapshotId: target.id, evidenceIds: target.evidence.map(item => item.id) }] : [];
}

export function validatedFocus(action: VisualAction, record: InvestigationRecord, taskRunIds: Set<string>): Snapshot | undefined {
  if (action.kind !== "focus_snapshot") return;
  const snapshot = record.snapshots.find(item => item.id === action.snapshotId && taskRunIds.has(item.runId));
  if (!snapshot || action.evidenceIds.some(id => !snapshot.evidence.some(item => item.id === id))) return;
  return snapshot;
}
