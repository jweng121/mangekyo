# CREAO attempt 5 delivery diagnosis

Read-only retrieval of completed external run
`5f9da458-9ab3-4e44-acfb-03972a7d4ce8` and the frozen input for
`synthetic-finance-case-001:task:001:investigation:5` established:

- `result.text` is a JSON string with only `status: "success"` and a short
  `summary` of the counts. It is not the finance report.
- `result.chatText` is a string starting with
  `I'll start by reading the agent's manifest and SKILL.md.` immediately followed
  by the complete `finance-investigation-output/v1` JSON object.
- `result.artifacts` is absent. There is no artifact to download for this run.

The previous adapter only parsed `result.text`. The updated adapter checks both
documented inline fields and extracts the single JSON suffix in this chatText.
It does not execute or obey the prose prefix. Different report objects across
fields are rejected; schema/citation/financial validation is unchanged.

The updated adapter was run against the existing completed provider run using
GET only. The extracted report passes validation against attempt 5's frozen
input: needs_information, five findings, five questions, no proposed allocations,
five evidence requests, and three proposed policies.

Provenance: `reportSource = {"field":"result.chatText","format":"json_suffix"}`.
New result records, events, and snapshots retain this provenance. A before/after
read confirmed the historical failed attempt was unchanged; no new investigation
or paid run was started. This diagnosis does not mark attempt 5 successful in the
database or overwrite its original failure.

Regression fixtures retain the actual synthetic response shape and frozen input,
without credentials. Tests cover extraction, strict validation, conflicting
reports, malformed/multiple objects, and refusal to fetch arbitrary artifact URLs.
The inline adapter explicitly refuses JSON attachments rather than silently
choosing between inline and attachment reports. Artifact-only delivery remains
unsupported; it must be implemented with CREAO's authenticated download endpoint
and cross-origin credential stripping if needed for a future run.

Reference: [CREAO API Trigger](https://docs.creao.ai/pro/api-trigger), including
the documented `result.chatText` field and artifact handling requirements.
