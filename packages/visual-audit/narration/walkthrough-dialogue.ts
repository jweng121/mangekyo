import type { AuditFinding, NarratedExplanation, Snapshot } from "@mangekyo/contracts";

const digits = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
/** Keep codes understandable in speech, without altering recorded evidence. */
export function spokenReference(value: string): string {
  return value.replace(/\b([A-Z]{1,4})-(\d+)\b/g, (_, prefix: string, number: string) => `${prefix.split("").join(" ")} ${number.split("").map(digit => digits[Number(digit)]).join(" ")}`);
}
const field = (snapshot: Snapshot, id: string) => snapshot.observation.fields.find(item => item.id === id)?.value;
const asText = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : undefined;

export function walkthroughDialogue(snapshot: Snapshot, snapshots: Snapshot[], finding: AuditFinding): string {
  const record = snapshot.observation.record;
  const owner = snapshots.flatMap(item => item.observation.record?.operation === "read" ? item.observation.record.rows : []).find(row => row.name)?.name;
  const proposal = snapshots.find(item => item.actionType === "PROPOSE");
  const proposed = proposal && (field(proposal, "proposed-owner") ?? proposal.observation.output?.proposedOwner);
  const bank = field(snapshot, "bank-reference");
  if (snapshot.actionType === "READ" && bank) {
    const [code] = bank.split(" / ");
    return `The agent read payment reference ${spokenReference(code)}. Let's check which client it belongs to.`;
  }
  const client = field(snapshot, "invoice-customer");
  if (snapshot.actionType === "READ" && client) {
    return `The funding instruction names ${client}. We still need to match it to the bank payment.`;
  }
  if (record?.operation === "read") {
    const code = record.filters.paymentCode;
    const opening = code ? `The agent searched for ${spokenReference(code)}.` : `The agent read the register without a payment filter.`;
    if (record.status === "failed") return `${opening} The read failed. No result is confirmed.`;
    if (record.status === "proposed") return `${opening} The query is proposed, not executed.`;
    if (!record.rows.length) return `${opening} The database returned no matching records. We need to verify the reference.`;
    if (record.rows.length > 1 || record.truncated) return `${opening} ${record.truncated ? `We're seeing only part of the result` : `The database returned ${record.rowCount} records`}. We need a more specific lookup.`;
    const row = record.rows[0];
    const name = asText(row.name), legal = asText(row.legal);
    const result = name ? `It returned ${name}${legal ? `, ${legal}` : ""}.` : `It returned one matching record.`;
    const mismatch = proposed && name && proposed !== name ? ` That's different from ${proposed}, the proposed owner.` : "";
    const context = mismatch;
    return `${opening} ${result}${context}`;
  }
  if (snapshot.actionType === "PROPOSE") {
    return proposed ? `The agent proposed ${proposed}.${owner && owner !== proposed ? ` The client lookup identified ${owner} instead.` : " This is a proposal, not a confirmed posting."}` : "The agent proposed an action. No write is confirmed yet.";
  }
  if (record) {
    if (record.status !== "succeeded") return `Here, the agent ${record.status === "failed" ? "attempted a database write, but it failed" : "proposed a database change"}. No saved change is confirmed.`;
    const savedClient = asText(record.rows[0]?.client);
    const changed = record.changes?.find(change => change.field === "client");
    const action = record.operation === "update" && changed ? `The agent updated the draft from ${changed.before} to ${changed.after}.` : record.operation === "insert" ? `The agent saved a new ${record.resource === "allocation_drafts" ? "allocation draft" : "record"}${savedClient ? ` for ${savedClient}` : ""}.` : `The database confirmed the ${record.operation === "delete" ? "deletion" : "update"}.`;
    const posting = record.rows[0]?.ledgerPosted === false ? " No financial ledger entry was posted." : "";
    return `${action}${posting}`;
  }
  if (snapshot.actionType === "AUDIT" || snapshot.actionType === "ESCALATE") return `This is Mangekyo's review of the recorded evidence. ${spokenReference(snapshot.summary)}`;
  // Older captures still have readable summaries, but never narrate raw tool responses or IDs.
  return `Let's look at this step. ${spokenReference(snapshot.summary)}`;
}

export function buildWalkthroughDialogue(runId: string, finding: AuditFinding, snapshots: Snapshot[]): NarratedExplanation {
  const evidence = snapshots.filter(item => item.runId === runId && item.sequence <= finding.reviewedThroughSequence && item.evidence.length).sort((a, b) => a.sequence - b.sequence);
  return { id: `walkthrough-${runId}`, messageId: finding.id, segments: evidence.map(snapshot => ({ id: `segment-${snapshot.id}`, text: walkthroughDialogue(snapshot, evidence, finding), snapshotId: snapshot.id, evidenceRefs: snapshot.evidence.map(item => item.id), highlightIds: snapshot.annotations?.map(item => item.id) ?? [], navigationTarget: { snapshotId: snapshot.id, evidenceRef: snapshot.evidence[0]?.id } })) };
}
