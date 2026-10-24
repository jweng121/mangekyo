# CREAO attempt 4 diagnosis

Attempt `synthetic-finance-case-001:task:001:investigation:4`, external run
`1facf890-6e8c-4076-a5f6-99dd9a3b42ef`, was inspected by reading its frozen
Convex input and polling the existing completed run through the CREAO adapter.
No new provider run was started and no prior attempt was rewritten.

The actual API `result.text` is:

```json
{"outcome":"needs_information","findings_count":6,"questions_count":6,"proposed_allocations_count":0,"total_amount_cents":0}
```

Required fields missing from that object:

- `$.schemaVersion`
- `$.summary`
- `$.findings`
- `$.questions`
- `$.proposedAllocations`
- `$.proposedActions`
- `$.candidatePolicies`

Unsupported extra fields: `$.findings_count`, `$.questions_count`,
`$.proposed_allocations_count`, `$.total_amount_cents`. Counts cannot replace the
required arrays. The only valid field in this response is `$.outcome`.

The user-provided `finance-investigation-output (1).json` is a different, full
report. It passes runtime schema, citation, and financial validation against
attempt 4's actual frozen input. Its citations are supported. This failure is
therefore a final-response contract violation, not an invalid citation in that file.

Required agent correction: return the full report object as the final API
`result.text`, not just as a downloadable JSON artifact. Do not output the count
summary. The adapter continues to validate the documented text result and does
not silently select or download attachments.

Implementation defect fixed: the backend previously discarded the validator's
reason. New failures preserve sanitized field paths and reasons in `error.details`
and snapshots, and the development UI renders them. Schema/financial checks remain
strict. Historical attempt 4 retains its original generic failure; this document
records its diagnosis without changing history.
