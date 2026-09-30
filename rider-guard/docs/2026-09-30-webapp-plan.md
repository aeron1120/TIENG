# Rider Guard web implementation plan

**Goal:** Complete the web app request in `2026-09-30-webapp-request.md` using the existing Hono/libSQL/Expo architecture.
**Spec:** `rider-guard/docs/2026-09-30-webapp-request.md` (user's authoritative request).
**Baseline:** `4653e45`, main. Earlier user authorization covers main push and existing Pages deployment. No new auth/DB provider.

## Constraints and design

- Keep native behavior where supported and existing protection/records/settings design. Web is primary.
- Support exact `https://rider-guard.expo.app/auth/callback` and `https://tieng.pages.dev/auth/callback`, with local web port 8081 in development.
- Google uses the existing server authorization-code flow, verified ID token, random state, PKCE and nonce, then one-use Rider Guard exchange. Secrets stay on Render.
- Report initial rule: >=6g AND (>=300 deg/s OR valid >=3m/s DV OR available abs(bank)>=45 deg), trailing 0.5s, DV 0.15s, initial evaluation >=0.15s. No stillness/GPS gate or whole-run peak mixing.
- Keep incoming router v1 compatibility, retain original data and versions. Add optional metadata and a new versioned evaluator; unknown provenance stays mock, never inferred from a filename.
- Tests use in-memory DB and explicit capture adapters; never contact real recipients or 119. Simulated delivery has a distinct result.
- Preserve 30s rider response and 60s contact stagger; neither is a validated sensor timing threshold.

## Tasks

1. [x] Authentication and session: Google ID signature/aud/iss/exp/sub + nonce verification, PKCE, atomic OAuth consumption; exact callbacks; session restore and errors; safe popup or same-tab handling; gating/timeout/cross-tab logout. Tests for invalid tokens, cancellation, replay, return URL restrictions, ownership and session lifecycle. Own auth modules and login screens only.
2. [x] Sensor candidate evaluator: add sensor-time rolling evaluation, packet/time diagnostics, raw-axis saturation, valid gravity-removed vector DV, first crossing/peak distinction, bounded waveform/evidence, initial report thresholds. Tests pin exact boundaries, irregular timestamps, missing sequence, shared receive times, candidate latch and D6/B3/C3 labelled mock fixtures. Own detection and adapter modules.
3. [x] Incident persistence and response: reuse evidenceJson/events/detections; retain metadata and raw trace; separate user feedback from truth; genuine recipient responses and simulated delivery; add authorized detail/export, sensor freshness from real reception. Tests pin ownership, consent, concurrency/idempotence, historical records and no external delivery.
4. [x] UI integration: maintain layout; protection distinguishes waiting/stale/connected, unsupported voice, location timestamps; records detail and export show provenance/rules/quality/waveforms without injury grades; error/empty/retry states; previews explicitly mock and recipient page uses scoped API. Build and type/lint checks.
5. [~] Review and final verification: server suite, app lint/typecheck/web build, manual HTTP smoke tests on local test adapters, scan bundle for public API configuration and secrets, update deployment values and limitations, commit/push authorized main updates. External OAuth and real sensor hardware are reported unverified without their credentials/data.

## Review focus

- Missing/late packets invalidate only DV; independent gyro trigger remains valid.
- Stale/anonymous data and previous-account caches never render as authenticated current-user data.
- Callback replays, concurrent responses and repeated packets create one session/event action.
- Historic evidence lacking new metadata renders unknown fields without invented timestamps/quality.
- Mock transport cannot produce real-delivery success claims.

## Progress

- Baseline inspected: own opaque-token auth, Google code exchange currently uses userinfo without explicit ID-token verification; browser session restore trusts stored token; no finite API timeout. Device/phone indicator ingestion and independent router v1 both exist. Raw IMU CSV adapter runs server-side.
- Existing default rule is 4g/600deg/s/3m/s/75deg plus stillness; it does not match this request and will be versioned/replaced for new evaluator records.
- Ruling: support both current Pages and requested Expo origins exactly; no wildcard previews. Cost if target changes: update explicit allowlist.

- 2026-09-30: UI·데모·보고 완료. 결과는 `2026-09-30-webapp-report.md`. 배포·커밋은 하지 않음(사용자가 직접).
