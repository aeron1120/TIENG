# Presentation monitor implementation plan

> Execution: superpowers:subagent-driven-development. Work is authorized by the user's implementation request. Backend and monitor files have independent owners; integration and verification remain with the root agent.

**Goal:** One presentation flow from measured/replayed data through server receipt, response and a report.
**Spec:** ../specs/2026-10-01-presentation-monitor-design.md
**Stack:** Node 24, Hono, libSQL, Zod, Expo 57, React Native Web; no new runtime dependency.

## Constraints

Keep existing staged user files untouched. Work in the current feature branch because repository metadata is read-only and dependencies already exist here. Never publish/deploy or invoke real dispatch providers as part of demo work. Distinguish measured evidence, imported router evidence and simulated workflow.

## Tasks

- [x] 1. Shared engine and automatic presentation. Move engine to packages/demo with a compatibility re-export. Add autopilot action/state, deterministic staged handling and terminal pause; tests cover accident, normal, rider cancellation and sensor loss. Root owns engine and rider tests.
- [x] 2. Durable presentation session API. Server worker owns db migration, service, routes, server app registration, presentation DTO and backend tests. Create source-specific sessions; accept ordered command batches; authenticate separate capabilities; persist receipt and expiration. Read returns state, clip and evidence. Reject real/live imports.
- [x] 3. Presentation monitor. UI worker owns standalone server HTML/JS/CSS and link from original ops screen. Read linked sessions; create measured/import sessions; run demo commands; display readable progress, evidence, timeline, orders, source and reception. Support print and JSON report.
- [x] 4. App bridge and UX. Root owns store action subscription, retry queue, connection panel, start/reset/pause/autoplay, server monitor links and report receipt context.
- [x] 5. Integration checks, independent review and fixes. Full tests, types/lint, web export and browser verification, then document launch flow.

## Interface

POST /demo-api/presentations: { scenario?: 'full'|'normal'|'curb'|'stopped'|'gap', caseId?: string, detection?: DetectionV1, origin?: 'integrated', baseWall?: number }.
Response: PresentationSession plus {readToken,writeToken,monitorPath}. Session: {id,source:{kind,label,note,caseId},state,clip,analysis,detection,lastSequence,receivedAt,expiresAt}.
GET /demo-api/presentations/:id with read or write Bearer token -> session. No secrets returned.
POST /demo-api/presentations/:id/commands with write Bearer token: {commands:[{seq,action}]}. Action is shared DemoAction except tick.clip is omitted and supplied by server from source. Up to 100 commands. Returns session. Duplicate sequences are ignored, gaps are 409, validation is 422. Tick dt ≤ 0.5.
Monitor link /ops/presentation#session=<id>&key=<readToken>. Server serves HTML plus same-origin script/style.

## Review focus

Reconnect preserves unacknowledged commands; server data survives process restart; repeated POST cannot duplicate actions; normal/imported noncandidate cannot become accident; read capability cannot mutate; a lost source tab is visibly stale rather than live; no accidental real provider call.

## Progress / decisions

- Design: use isolated server-backed presentation sessions and deterministic command replay. Existing production ingestion remains available unchanged.
- Ruling: implement authorized reversible work without additional staged approval prompts; user explicitly requested complete high-quality implementation and selected whole-flow demo.
- Baseline: existing staged files apps/server/scripts/update-rule-tests.py and apps/server/test-results.tmp are user work.

- Verification complete: rider 24/24 and server 138/138 tests; both typechecks and lint passed; Expo web export passed. HTTP smoke verified integrated A1 resolved with 2 reassignments, D7 no_candidate and D6 insufficient, repeat commands and readonly fetch consistency.
- Independent review fixed stale evidence on source reset, insufficient/missed-data labeling, and two-tab fresh-session reset propagation. Regression tests cover each.
- Browser visual inspection unavailable: CUA reports no browsers and iab/chrome creation unavailable. Shipped monitor script exercised against real app API in dependency-free DOM tests; responsive CSS and print styles implemented but not visually verified.
- Preview running via npm run presentation at http://localhost:4001/demo and /ops/presentation. No deployment or commits; user staged files preserved.
