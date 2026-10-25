import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import type { InvestigationRun, RecordEvidence } from "../../../../../../packages/contracts";
import { assertLocalAccess } from "../../../../lib/local-access";
import { addRun, appendAudit, appendChatMessage, artifactDirectory, localTenantId, readInvestigation } from "../../../../lib/local-store";
import { captureStructuredCheckpoint } from "../../../../lib/capture-agent";
import { evidenceWorker } from "../../../../lib/evidence-worker";

export const runtime = "nodejs";
let active = false;
const examples = [
  { key: "single", title: "DB Read / Client mismatch", code: "B-204", explanation: "The request names Client A, but the payment reference B-204 returns Client B. Review the returned owner before preparing an allocation.", category: "ownership_conflict" as const },
  { key: "multiple", title: "DB Read / Multiple records", code: undefined, explanation: "The agent read the entire client register without a payment-reference filter. Four records were returned; this result alone does not establish which client owns the receipt.", category: "missing_evidence" as const },
  { key: "empty", title: "DB Read / No matching record", code: "Z-999", explanation: "The payment reference Z-999 returned no client records. The agent must request the correct reference or additional evidence before allocating the receipt.", category: "missing_evidence" as const },
];
export async function POST(request: NextRequest) {
  let acquired = false;
  try {
    assertLocalAccess(request);
    if (active) return NextResponse.json({ error: "Examples are being created" }, { status: 409 });
    active = true; acquired = true;
    const results = [];
    for (const example of examples) {
      const taskId = `db-read-example-${example.key}`;
      const existing = (await readInvestigation()).runs.find(run => run.taskId === taskId);
      if (existing) { results.push({ id: existing.id, title: existing.displayName, existing: true }); continue; }
      const result = await evidenceWorker<{ record: RecordEvidence }>({ action: "read", paymentCode: example.code, databasePath: path.join(artifactDirectory(), "..", "trust-ledger.sqlite") });
      const run: InvestigationRun = { id: crypto.randomUUID(), displayName: example.title, schemaVersion: 1, tenantId: localTenantId(), taskId, agentId: "trust-records-agent", branchId: "original", createdAt: new Date().toISOString(), status: "escalated" };
      await addRun(run);
      const snapshot = await captureStructuredCheckpoint({ run, sequence: 1, actionType: "READ", title: "Client lookup", summary: example.explanation, documentId: "trust_clients", documentVersion: result.record.executedAt,
        toolCall: example.code ? `SELECT * FROM trust_clients WHERE code = ?; parameters: ["${example.code}"]` : "SELECT * FROM trust_clients ORDER BY id",
        toolResponse: JSON.stringify(result.record.rows), observation: { label: "Trust client register", record: result.record, fields: [{ id: "lookup-result", label: "Client lookup result", value: example.code ? `${example.code}: ${result.record.rowCount} matching records` : `${result.record.rowCount} client records; no payment reference filter`, emphasis: "read" }] } });
      const findingId = crypto.randomUUID();
      await appendAudit({ id: findingId, schemaVersion: 1, runId: run.id, snapshotId: snapshot.id, category: example.category, severity: "medium", explanation: example.explanation, evidence: snapshot.evidence, suggestedAction: "Inspect the recorded query and results. This read-only example does not perform an allocation.", reviewStatus: "open", reviewedThroughSequence: 1 }, { id: crypto.randomUUID(), findingId, snapshotId: snapshot.id, runId: run.id, status: "open", createdAt: run.createdAt });
      await appendChatMessage({ id: crypto.randomUUID(), runId: run.id, role: "assistant", text: `Database read example. ${example.explanation} This is an actual SQLite read of fictional local records. No write was performed.`, snapshotIds: [snapshot.id], provider: "local", createdAt: run.createdAt, conversationId: "default", conversationTitle: "Database review" });
      results.push({ id: run.id, title: run.displayName, rows: result.record.rowCount });
    }
    return NextResponse.json({ examples: results });
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 500 }); }
  finally { if (acquired) active = false; }
}
