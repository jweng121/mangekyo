Mangekyo Visual Audit UI Redesign — Final Implementation Prompt
Project scope
You are redesigning only the visual auditing subsystem UI of Mangekyo.
Mangekyo is an autonomous trust-account management platform built on visual auditing. Edwin owns the financial operations platform and agent workflows. I own the visual audit interface — the part where a human reviewer can see what an agent saw, trace where a misalignment occurred, review evidence, send corrections, and track the corrected branch.
This is not the overall Mangekyo finance platform dashboard.
This is not a generic workflows dashboard.
This is not a ChatGPT clone.
This is the human review and intervention interface for escalated agent tasks.
Work primarily in:
- packages/visual-audit/
- apps/visual-audit-dev/
Preserve compatibility with:
- packages/contracts/
Do not modify Edwin’s finance-core business logic.
Mandatory design references
Inspect and use these uploaded UI images as design references before implementing the redesign.
Uploaded references
1. Graph / branch history reference
   ``
2. Correction / memory confirmation icon reference
   ``
3. Example reporting / AI workspace visual reference
   ``
4. Current Mangekyo interface mockup to refine
   ``
Also use the previously supplied design references already discussed in the project, especially the visual language from:
- the soft AI assistant message bubble concept
- the Hyphenate-style review UI
- the floating approval / suggestion visual direction
- the screenshot-based review workflow concepts
If any required image cannot be accessed, report that clearly.
Do not merely describe the references. Use them to drive the layout, interaction model, annotation style, graph presentation, and confirmation messages.
1. High-level product goal
The visual audit UI should let a nontechnical accountant or reviewer:
1. See only the tasks that have been flagged for escalation
2. Open a review case
3. See the actual screenshots the tasked agent saw
4. Understand the misalignment through visual evidence and short annotations
5. Click annotations to highlight the exact corresponding document region
6. Ask follow-up questions in chat
7. Send a correction through chat
8. Watch a corrected branch appear from the misaligned snapshot
9. Review the updated result
10. Mark the case resolved so it disappears from the escalation queue and is considered approved/resolved
This UI should feel clean, visual, fluid, and highly legible.
It must not feel stiff, boxy, over-labeled, or overly technical.
2. Core changes required
Remove / change the following
Remove the Dynamic Island
Do not use the dynamic island floating assistant approach.
Replace it with a more integrated right-side review interface containing:
- annotations
- chat
- correction entry
- fixed agent messages
- suggested actions
Do not show general workflows
The left sidebar should not list all workflows or all tasks in the system.
It should show only escalated review cases.
These are the tasks that actually require human review.
Normal automated tasks should already run without appearing here unless escalated.
Do not label timeline items as “Step 1 of 7”
Use the word:
- Snapshot 1
- Snapshot 2
- Snapshot 3
etc.
This is important because the system is based on captured observations, not a fixed process wizard.
Remove “original run” and “saved run” tags
Do not surface labels like:
- original run
- saved run
These are unnecessary and visually noisy.
The branch relationship should be communicated through the graph visually, not through clunky tags.
Remove purple as the primary color system
Do not use purple as the dominant accent color.
Prefer:
- neutral dark/ink text
- soft greys
- off-white backgrounds
- restrained blue for interactive elements
- red for misalignment/error nodes
- green for corrected branch outcomes
- subtle amber/orange only where helpful for warnings
The interface should feel premium and calm, not saturated.
3. Layout structure
Left sidebar: only escalated review cases
The left sidebar should only contain cases flagged for escalation.
Each case row should include:
- task / case name
- agent name
- short issue title
- severity indicator if relevant
- status = escalated
- maybe a subtle unread/recent indicator
Example case titles:
- Resolve deposit ownership mismatch
- Investigate trust allocation discrepancy
- Review inconsistent receipt amount
- Verify conflicting beneficiary evidence
This list is the reviewer’s inbox.
When a case is resolved and approved, it should no longer appear in this escalated queue.
It can be moved to an approved/resolved archive view if needed, but it should be hidden from the escalation inbox.
Main center canvas: document / screenshot review
The center of the screen should primarily show:
- the selected screenshot / captured visual observation
- subtle evidence highlights
- linked annotation behavior
- enough space to inspect the document clearly
This should be the visual focus of the page.
Do not crowd it with big white cards.
Top branch graph: snapshot nodes and correction branch
At the top of the case review page, display a branch graph inspired by the provided graph image.
This graph should show the review history as snapshots.
Graph requirements
- each node = a snapshot
- each node corresponds to a meaningful observed checkpoint
- show title + short caption
- a red node = where misalignment / conflict occurred
- when a correction is processed, animate a green branch emerging from that red node
- the green branch represents the corrected run
- the graph should look like an execution history, not a generic flowchart
- graph should be compact, elegant, and visually readable
Example sequence:
- Snapshot 1 — Bank Statement — READ payment reference
- Snapshot 2 — Invoice INV-2048 — READ client name
- Snapshot 3 — Ownership Proposal — PROPOSE Client A
- red conflict appears at Snapshot 3
- corrected green branch emerges:
  - Corrected branch — Re-evaluate ownership with human steering
The graph should not rely on large technical labels.
Right sidebar: annotations + chat + suggestions
The right side should include two main stacked regions:
A. Annotations section
A dedicated section called something like:
- Annotations
- Review notes
- Mangekyo notes
This section should contain annotation messages written in the voice of the Mangekyo agent.
These should look more like conversational notes than stiff cards.
Each annotation should be clickable.
Clicking an annotation should:
1. focus the screenshot
2. highlight the exact evidence region it refers to
3. bring that region into clearer view
The annotation style should be inspired by Crowdmark-style review annotations, but adapted to Mangekyo.
That means:
- annotation text should feel attached to the evidence
- visually lightweight
- contextual
- easy to click
- directly connected to a document region
B. Chat section
Below or beside annotations, include a real conversational chat section.
This is where the reviewer can:
- ask follow-up questions
- instruct Mangekyo
- send a correction
- confirm or refine steering instructions
When the user clicks a suggested action, it should bring focus directly to the chat input so the user can continue from there.
4. Annotation interaction behavior
This is very important.
The annotation system should behave like this:
Default highlight state
The evidence region on the screenshot should appear as a soft translucent highlight.
Not a thick border.
Not a harsh yellow box.
Not an ugly opaque overlay.
Use:
- soft translucent fill
- subtle outline or glow
- muted tint
- elegant focus treatment
Click annotation behavior
When the reviewer clicks an annotation message in the right sidebar:
- the related evidence region becomes more visually prominent
- the screenshot can gently pan/zoom if appropriate
- the highlight becomes more focused / more visible
- the reviewer can clearly see what the annotation refers to
Click highlight behavior
When the reviewer clicks the translucent highlighted area directly on the screenshot:
- the corresponding annotation should be activated or brought into view
- the relationship between annotation and evidence should feel two-way
This linkage is essential.
Do not use crude highlight styling
Avoid:
- thick yellow rectangles
- rigid red boxes unless specifically representing a conflict
- visually harsh selection states
The highlight system should feel carefully designed and premium.
5. Visual history panel placement
The visual history should be on the right side in graph form as requested, not a bottom card with left/right arrows.
More specifically:
- top = graph / branch structure
- center = screenshot / document
- right = annotations + chat
- left = escalated case list
If snapshot thumbnails are used, they should be subordinate to the graph or integrated elegantly.
Do not use a clunky “previous / next card” UI as the primary history interaction.
6. Message and confirmation style
Use the message/confirmation icon style from the provided correction/memory reference image.
These are the three key system confirmations:
1. Correction sent
2. Corrected run completed
3. Context saved to agent memory
Use distinct icons consistent with the provided image direction.
Required icon/message patterns
Correction sent
Use a send / paper-plane style icon.
Message text:
- Title: Correction sent
- Body: The tasked agent’s runtime accepted the steering request.
Corrected run completed
Use a branch / workflow / rerun icon.
Message text:
- Title: Corrected run completed
- Body: The tasked agent reran the affected work, and Mangekyo recorded its new observations.
Context saved to agent memory
Use a brain / memory icon.
Message text:
- Title: Context saved to agent memory
- Body: The approved correction was saved and made available to the appropriate agent for future applicable runs.
These should appear as elegant, lightweight system messages in the review flow.
Do not use giant notification cards.
Do not use bulky banners.
7. Fixed chat messages for corrections
Include a set of fixed messages Mangekyo can show in chat when corrections are being made.
These should be built into the UI flow.
Use these exact or near-exact messages:
When user chooses a suggested action
I can help you correct this case. Tell me how you’d like the agent to reconsider the evidence.
When correction is being drafted
I’m preparing a correction for the tasked agent based on this evidence.
When correction is submitted
I’ve sent your correction to the tasked agent.
When rerun begins
The tasked agent is reviewing the affected evidence again.
When rerun completes
The corrected run is complete. I’ve recorded the updated observations.
When result improves
The conflict has been resolved in the corrected branch.
When memory is proposed
I’ve prepared this correction as reusable context for future similar tasks.
When memory is saved
The approved context has been saved to agent memory.
When case is ready to close
This review case is ready to be approved and removed from the escalation queue.
These messages should feel like the Mangekyo agent is actively helping the reviewer, not dumping technical logs.
8. Suggested actions behavior
Suggested actions should be visible in the review UI.
Examples:
- Review evidence
- Ask why this was flagged
- Correct the ownership decision
- Re-evaluate using bank statement
- Save this correction for future runs
When the user clicks a suggested action:
- it should focus or open the chat input
- optionally prefill the intent or prompt
- the user can then submit or refine it
This makes the correction flow feel conversational.
9. Case resolution behavior
After the correction is made and the case has been resolved:
- Mangekyo should close the review case
- the case should no longer appear in the left escalated-case inbox
- it should be treated as approved/resolved
- optionally it can be accessible in a resolved/approved archive
The escalated queue should show only cases currently requiring human intervention.
10. Naming and wording cleanup
Use clean, natural wording.
Prefer
- Snapshot 1
- Snapshot 2
- Snapshot 3
- Annotations
- Suggested actions
- Chat
- Escalated
- Approved
- Corrected branch
Avoid
- Step 1 of 7
- Original run
- Saved run
- Large all-caps labels
- Technical jargon in the main UI
- Raw UUIDs / screenshot sizes / internal trace IDs
If technical metadata is preserved, hide it behind an advanced details view.
11. Interaction model
Opening a case
When the reviewer clicks an escalated case:
1. show top branch graph
2. show selected snapshot in center
3. show annotations on the right
4. show chat on the right
5. default to the conflict snapshot if one exists
Reviewing evidence
When the reviewer clicks an annotation:
- the screenshot highlight becomes more prominent
- the referenced part scrolls into focus if needed
Sending a correction
When the reviewer chooses a suggested action or types in chat:
- Mangekyo helps send a steering request
- system messages appear in sequence
- graph updates when corrected branch begins
After correction
- corrected branch becomes visible in green
- updated outcome can be reviewed
- resolution message appears
- case can be closed / approved / removed from escalation queue
12. Visual style
General style
The UI should feel refined, modern, and fluid.
Keep
- off-white / light neutral background
- dark text
- restrained accent colors
- thin lines
- soft shadows
- rounded corners
- generous whitespace
Remove
- purple-heavy accents
- oversized blocks
- stiff card-heavy panels
- loud borders
- unnecessary tags
Annotation feel
Make annotations feel like comments attached to evidence.
Chat feel
Make chat feel integrated into review, not like a separate chatbot app.
Graph feel
Make the graph elegant and visually meaningful, not technical clutter.
13. Functional requirements to preserve
Preserve the existing capabilities where they already exist:
- snapshot history
- live or recorded evidence viewing
- steering / correction flow
- branch creation
- case escalation
- chat behavior
- memory save flow
- narrated explanation support if present
- event / snapshot / branch provenance in the underlying data model
Do not throw away working architecture unnecessarily.
14. Implementation guidance
Inspect the current UI implementation and identify components to remove or redesign.
Likely areas to revise include:
- task sidebar
- snapshot graph / workflow graph
- snapshot viewer
- annotations pane
- chat pane
- suggestion components
- steering composer
- resolution flow
- confirmation messages
You may create or refactor components such as:
- EscalatedCaseSidebar
- SnapshotBranchGraph
- SnapshotCanvas
- DocumentAnnotationLayer
- AnnotationList
- ReviewChatPanel
- SuggestedActions
- CorrectionStatusMessage
- ResolvedCaseHandler
Adapt these names to the actual codebase.
15. Acceptance criteria
The redesign is successful when:
1. The left sidebar shows only escalated review cases
2. A selected case opens a screenshot-based review workspace
3. The top graph shows snapshots as nodes
4. Misalignment nodes are red
5. A corrected branch animates from the red node in green after correction
6. The main screenshot is the central focus
7. The right sidebar contains annotations and chat
8. Clicking an annotation highlights the corresponding evidence region
9. Clicking the evidence region can activate the annotation
10. Highlights are translucent and elegant, not thick yellow boxes
11. The UI uses Snapshot 1, Snapshot 2, etc., not step numbering
12. The UI no longer shows original run or saved run
13. The UI no longer relies on purple as a primary design color
14. Suggested actions route users into chat
15. Fixed correction-related messages appear appropriately in chat
16. Confirmation messages use the requested icon/message style
17. After resolution, the case disappears from the escalated queue and is treated as approved/resolved
18. The overall UI feels visually refined and not stiff
19. The uploaded image references clearly influence the layout and interaction design
20. Existing underlying functionality remains compatible
16. Final instruction to Codex
Inspect the current visual-audit implementation and the referenced images first.
Then redesign the UI to follow this exact review model:
- escalated cases only in the left sidebar
- top snapshot branch graph
- center screenshot canvas
- right-side annotations + chat
- annotation-driven highlighting
- conversational correction flow
- green corrected branch after rerun
- approved cases removed from escalation inbox
Make the interface elegant and fluid.
The final result should feel like a professional visual review tool for autonomous-agent escalations — not a workflow dashboard and not a chatbot.