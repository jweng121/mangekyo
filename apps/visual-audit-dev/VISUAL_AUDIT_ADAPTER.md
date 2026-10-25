# Visual audit execution adapter

The workspace reads one `InvestigationRecord` for both Monitor and Investigation. It never synthesizes browser screenshots. A rendered observation must come from the same Playwright `Page` used by the tasked agent:

```ts
import { createMonitoredRun, captureBrowserCheckpoint } from "./lib/capture-agent";

const run = await createMonitoredRun({
  tenantId: "harbor-trust-demo",
  taskId: "bank-line-1042",
  agentId: "deposit-matching-agent",
});

await captureBrowserCheckpoint({
  page, run, sequence: 1, parentEventIds: [],
  actionType: "READ", title: "Bank payment reference",
  summary: "Read the payment reference on bank line 1042.",
  locator: page.getByTestId("bank-reference"),
  fieldId: "bank-reference", fieldLabel: "Bank reference",
  documentId: "bank-line-1042", documentVersion: "2026-10-24",
  toolCall: "Read bank reference", toolResponse: "B-204",
});
```

Call `captureBrowserCheckpoint` after each meaningful rendered READ, PROPOSE, or WRITE observation. It captures an immutable PNG from Playwright, records viewport coordinates for the targeted locator, and appends the event and snapshot together. Repeated visits use the same `documentId` with the version observed at that checkpoint. `WRITE_CONFIRMED` is reserved for a confirmed write; a draft submission uses `WRITE_ATTEMPT`.

For nonvisual tools, use `captureStructuredCheckpoint` from the same adapter, or `POST /api/visual-audit/observations` with `action: "structured"`. The endpoint also supports `action: "start"` and `action: "finish"` for locally connected agents. Structured observations are explicitly labeled and never receive a screenshot URL. The dev server limits these routes to localhost; deployment must provide its own authenticated transport and tenant authorization. The artifact route checks that each requested PNG belongs to a snapshot in the active tenant.

Steering in the demo routes through `runBrowserAgent` and creates a fresh corrected run. A deployed execution adapter should use the saved `SteeringRequest` to restart the tasked agent, capture a new branch, and preserve the original run and all gateway approval requirements.
