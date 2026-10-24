import type { FinanceCaseBundle } from "@mangekyo/contracts";

export function FinanceCaseView({ data }: { data: FinanceCaseBundle }) {
  const { owner, transaction, document, task } = data;
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: transaction.currency })
    .format(transaction.amountCents / 100);
  return (
    <section aria-label="Synthetic finance case">
      <h2>Saved finance case <small>synthetic</small></h2>
      <dl>
        <dt>Candidate client / owner</dt><dd>{owner.name}</dd>
        <dt>Cleared bank deposit</dt><dd>{amount} · {transaction.bankStatus} · {transaction.allocationStatus}</dd>
        <dt>Task status</dt><dd>{task.status}</dd>
        <dt>Case ID</dt><dd><code>{data.case.caseId}</code></dd>
        <dt>Task ID</dt><dd><code>{task.taskId}</code></dd>
        <dt>Run ID</dt><dd><code>{task.runId}</code></dd>
      </dl>
      <p role="note">Ownership is unverified. No client allocation or financial action is approved.</p>
      <h3>Supporting evidence</h3>
      <p>{document.title}</p>
      <p><code>{document.sourceId}</code> · {document.mimeType}</p>
      <blockquote>{document.excerpt}</blockquote>
      <details><summary>Full synthetic document</summary><p>{document.text}</p></details>
    </section>
  );
}
