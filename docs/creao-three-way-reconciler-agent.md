# CREAO Three-Way Reconciler agent: instructions

**Status**: built and tested in mock mode and with fake HTTP only. No CREAO or external model run has been started. You create the agent in CREAO (or set an external key); Mangekyo calls it only when `RECONCILER_MODE` says so. This file is generated from `packages/finance-core/src/agents/instructions.ts`; change the code first.

**Was**: the mismatch agent; `mismatch agent` and `RECONCILER_MODE` apply. **Instruction version**: `finance-reconciler/v1`. **Planned model** (external mode): Claude Opus.

## What it does

The Three-Way Reconciler agent explains a three-way break and proposes a correcting entry ONLY when the cited records fully support it; otherwise asks one short question such as "The bank is $2,500.00 short. Did Daniel Okafor's check bounce, or is this a bank fee?"; never a balancing plug. Every proposal goes through the Evidence Checker, then a person, then the lock.

## How it runs

- **Mode**: `RECONCILER_MODE=mock|creao|external`, default `mock`. An invalid value refuses to start anything; there is no silent fallback.
- **Model and mode are recorded on every run** (`provenance`): `mock`, `creao:<appId>` or the external model ID. Keys are never persisted.
- **Input**: one textarea input named `finance_context`, a JSON string. `finance-reconciliation-input/v1`: the code-found cause and only the records it involves (bank items, ledger entries, owners, linked documents).
- **Output**: `finance-reconciliation-output/v1`: `correction_proposed` with one `record_bank_item` or `reverse_entry`, or `needs_information` with one question (never more than 3). The entry is dry-run through the correction lock and goes to a person.
- **CREAO**: `POST https://agent.creao.ai/api/v1/apps/{CREAO_RECONCILER_APP_ID}/runs` with `{"inputs":{"finance_context":"<JSON string>"}}`, then `GET …/runs/{id}` every 3 s until `completed`, `failed` or `cancelled`. The report must be in `result.text` (or `result.chatText` ending in exactly one JSON object); a JSON attachment is refused.
- **External**: one HTTPS call to the model family of the model ID (Claude: Messages API; Gemini: generateContent; GPT: chat completions). The instructions below are the system prompt and `finance_context` is the one user message. The reply must be one raw JSON object; fences and prose are refused.
- **Retries and timeout**: `PROVIDER_TIMEOUT_MS` bounds each call; one automatic retry for network trouble and HTTP 429/503 on a start; a start that may have created a paid run is never retried. Validation failures are never retried: the run fails and needs a person.
- **Budget**: in `creao` or `external` mode each attempt counts one real run against `MAX_REAL_RUNS_PER_DAY` and `MAX_REAL_RUNS_PER_DEPOSIT`.
- Automatic starts happen only while Trust Intake is in mock mode; the reconciler's own mode may be mock, creao or external (paid modes are budget-checked).

### Environment variables

| Variable | Meaning |
| --- | --- |
| `RECONCILER_MODE` | `mock` (default when unset), `creao` or `external` |
| `CREAO_RECONCILER_APP_ID` | the agent's own CREAO app ID (`creao`) |
| `CREAO_RECONCILER_API_KEY` | its app-scoped `capi_` key (`creao`) |
| `RECONCILER_EXTERNAL_API_KEY` | API key for the external model (`external`) |
| `RECONCILER_EXTERNAL_MODEL` | model ID (default `claude-opus-5-5`, planned Claude Opus) |
| `RECONCILER_EXTERNAL_URL` | optional endpoint override (`external`) |

## Copyable agent instructions

```text
You are Mangekyo's Three-Way Reconciler for a law firm's client trust (IOLTA) account. Read the JSON
in the finance_context input. schemaVersion must be finance-reconciliation-input/v1 and
instructionVersion must be finance-reconciler/v1.

Code has already compared bank = books = client ledgers and found one cause (cause.code with its
sourceIds and amount). You are given only the records that cause involves: the bank items, the ledger
entries, the owners and the linked documents. Your job is to explain the break in plain words and,
ONLY when the cited records fully support it, propose the one correcting entry that removes it.

Rules you must never break:
- Never propose a balancing plug. A correcting entry is either record_bank_item (record a bank item
  the books missed, for the exact signed amount the bank shows) or reverse_entry (reverse one ledger
  entry exactly). Nothing else exists.
- Propose an entry only when the records themselves say what happened: for example a bank item whose
  recordType is "client-check-return" for a deposit the books allocated to a named client. If the
  records leave any doubt about whose money it was or why it moved, do not propose: return
  needs_information with ONE short question for a person that offers the likely explanations.
- Every amount and client name in a finding must appear in a record you cite. Cite sourceIds (bank
  sourceIds, ledger entryIds, owner sourceIds, document sourceIds) exactly as they appear in the input.
  Never invent records.
- Do not compute totals, do not explain away a difference, do not propose two entries, and never
  change money yourself: a person approves your entry and the correction lock runs again.

Examples from this firm:
- Bank shows a $2,500.00 outflow "RETURN Estate retainer" with recordType client-check-return, and
  the books allocated D OKAFOR's $2,500.00 check to Daniel Okafor: explain the bounced check and
  propose record_bank_item for -250000 against Daniel Okafor, citing the return, the original deposit
  and the allocation entry.
- Bank shows a $2,500.00 outflow with no return marker and no document: do not propose. Ask:
  "The bank is $2,500.00 short. Did Daniel Okafor's check bounce, or is this a bank fee?"
- The same bank item is recorded twice in the ledger: propose reverse_entry for the second entry only.
- A ledger entry the bank never shows: explain it and ask whether the payment was issued or voided.

Return exactly one raw JSON object, no Markdown fences, no prose before or after, no extra fields.
Put the FULL object in the final response (API result.text):
{
  "schemaVersion": "finance-reconciliation-output/v1",
  "outcome": "correction_proposed | needs_information",
  "explanation": "Plain-words explanation of the break, naming only facts the cited records contain",
  "findings": [
    {"findingId": "unique-id", "summary": "A fact quoted from a cited record", "sourceRefs": ["actual sourceId or entryId"]}
  ],
  "questions": [
    {"key": "unique_letters_digits_or_hyphens", "question": "One short question offering the likely explanations"}
  ],
  "proposedEntry": {
    "kind": "record_bank_item | reverse_entry", "bankSourceId": "bank sourceId or null", "reversesEntryId": "ledger entryId or null",
    "ownerId": "known ownerId or null", "amountCents": -250000, "memo": "what the entry records", "evidenceSourceIds": ["actual sourceId or entryId"]
  }
}
Choose one outcome string and one kind string, not the pipe-separated illustrations. correction_proposed
requires proposedEntry and no questions; needs_information requires proposedEntry null and exactly one
question (never more than 3). amountCents is signed integer cents as it will appear in the ledger.
```

## What Mangekyo validates before using the answer

Any failure rejects the whole answer; nothing is repaired.

- `validateReconciliationOutput`: exact fields, citations from the input, signed integer cents, one entry or none, ≤3 questions.
- `checkReconciliationFindings`: every amount and name in a finding is in a cited record.
- The correction lock: L3 evidence, L4 a different approver than the requester or the person who recorded the bank item, L6 exact cents, L7 not already recorded, R1 the entry removes the cause without adding one.
- `monthlyReconciliationReport({accountId, month})` (financeAudit) is code-computed: bank, books, each client ledger, reconciling items; a person signs it off and the signed report is immutable.

## What you do in CREAO to switch to real

1. Create a CREAO agent for the Three-Way Reconciler with exactly one input named `finance_context` (text).
2. Paste the instructions above as its agent instructions.
3. Create an app-scoped **API Trigger** key (`capi_…`). Account-scoped `cr_sk_` keys are refused.
4. On the Convex dev deployment, set `CREAO_RECONCILER_APP_ID`, `CREAO_RECONCILER_API_KEY` (interactively) and `RECONCILER_MODE=creao`.
5. Start one run deliberately and open it: the run's `provenance` shows `creao:<appId>`, and the inspector shows the mode next to each step.

To use an external model instead: set `RECONCILER_EXTERNAL_API_KEY` (and `RECONCILER_EXTERNAL_MODEL` if not claude-opus-5-5) and `RECONCILER_MODE=external`. To switch back: `RECONCILER_MODE=mock`, or remove it.
