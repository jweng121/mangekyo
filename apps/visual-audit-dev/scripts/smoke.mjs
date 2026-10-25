import assert from "node:assert/strict";

const base = process.env.MANGEKYO_APP_URL || "http://localhost:3000";
async function post(path, body) {
  const response = await fetch(new URL(path, base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

const started = await post("/api/visual-audit", { action: "start" });
const original = started.run;
assert.equal(original.status, "escalated");
assert.equal(original.proposedOwner, "Client A");
const originalSnapshots = started.record.snapshots.filter(snapshot => snapshot.runId === original.id);
assert.equal(originalSnapshots.length, 7);
assert.equal(started.record.findings.filter(finding => finding.runId === original.id).length, 1);
assert.equal(started.record.escalations.filter(escalation => escalation.runId === original.id).length, 1);
for (const snapshot of originalSnapshots.filter(item => item.sequence <= 5)) {
  assert.equal(snapshot.screenshot?.provenance, "actual");
  assert.equal(snapshot.observation.kind, "browser");
  assert(snapshot.documentId && snapshot.documentVersion);
  assert.equal(snapshot.screenshot.capturedAt, snapshot.timestamp);
  assert(snapshot.screenshot.artifactId);
  assert(snapshot.viewport.width > 0 && snapshot.viewport.height > 0);
  assert(snapshot.toolResponse);
  const artifact = await fetch(new URL(snapshot.screenshot.url, base));
  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get("content-type"), "image/png");
}
const observed = originalSnapshots.find(snapshot => snapshot.sequence === 3);
assert(observed.annotations[0].region);
assert(observed.annotations[0].region.x + observed.annotations[0].region.width <= 1);
const proposal = originalSnapshots.find(snapshot => snapshot.sequence === 4);
assert(proposal.annotations[0].region, "draft selector must be visible in its capture");
const steered = await post("/api/visual-audit", { action: "steer", snapshotId: proposal.id, instruction: "Verify the original bank payment reference and customer ownership. Correct the Client A allocation if B-204 identifies Client B.", scope: "dependent_work" });
assert.equal(steered.corrected.parentRunId, original.id);
assert.equal(steered.corrected.proposedOwner, "Client B");
assert.equal(steered.record.snapshots.find(snapshot => snapshot.runId === steered.corrected.id && snapshot.sequence === 1).parentSnapshotId, proposal.id);
assert.equal(steered.record.snapshots.filter(snapshot => snapshot.runId === steered.corrected.id).length, 6);
assert.equal(steered.record.reports.at(-1).status, "draft");
assert(steered.record.snapshots.find(snapshot => snapshot.id === proposal.id), "original history remains available");
const report = steered.record.reports.at(-1);
for (const status of ["pending_review", "approved", "filed"]) {
  const revision = await post("/api/visual-audit/reports", { id: report.id, content: report.content, status });
  assert.equal(revision.report.status, status);
}
const proposedMemory = await post("/api/visual-audit/memory", { action: "propose", reportId: report.id });
assert.equal(proposedMemory.memory.status, "pending");
const authorizedMemory = await post("/api/visual-audit/memory", { action: "approve", memoryId: proposedMemory.memory.id });
assert.equal(authorizedMemory.memory.status, "approved");
const future = await post("/api/visual-audit", { action: "future" });
assert.equal(future.run.proposedOwner, "Client B");
assert(future.record.snapshots.filter(snapshot => snapshot.runId === future.run.id).some(snapshot => snapshot.memoryRefs?.includes(authorizedMemory.memory.id)));
console.log(`Phase 2 smoke passed: ${original.id} -> ${steered.corrected.id} -> ${future.run.id}; 15 real Chromium captures; filed report and approved scoped memory.`);
