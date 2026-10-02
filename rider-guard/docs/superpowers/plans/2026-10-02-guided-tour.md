# Spotlight guide tour implementation plan

**Goal:** Add restartable, Korean spotlight tours to `/demo` and the signed-in `/home`, suitable for a live presentation.

**Design:** Share a React Native modal, measured target registry and scroll controller. Four dark panels leave a bright target, with an intercepting transparent layer. Use the existing asphalt/white/green palette and Pretendard. Keep data and navigation actions out of the tour. Pause demo playback when the guide opens; leave it paused for an explicit resume. Home protection services remain active.

**Constraints:** Expo 57 / React Native 0.86; no new dependencies; preserve native compatibility and existing user changes. Hidden/unmounted targets are skipped; below-fold targets are scrolled to. Restore scroll and focus on exit, remove input locks on route change, honor reduced motion.

- [x] Test viewport placement, scroll bounds and missing-target navigation with the existing Node test runner.
- [x] Implement shared tour geometry, target registration, modal, input isolation and cancellable motion.
- [x] Integrate demo targets (scenarios, playback, status, rider, control, wave, optional report, view/options) and pause playback.
- [x] Integrate home targets (map, protection timeline, sensor readiness, affiliation, notifications, bottom navigation). Add help buttons to both screens.
- [x] Add `/demo/home` with shared home UI and isolated local presentation input; keep `/home` bound to real account data. No mock badge, device permissions, or API mutations in the presentation home.
- [x] Run rider tests (79 passing), typecheck, lint and web export. Input-isolation tests cover repeated lock/unlock, keyboard navigation, restored background state and hidden targets.
- [ ] Exercise desktop/mobile tours, completion, rapid navigation, resize and animations in an actual browser. Environment has no connected browsers; `cua.getState()` returned none and `createBrowserTab('iab', ...)` was unavailable. Native devices also unavailable.

Web export succeeds with the existing missing `google-services.json` warning for Android configuration. That file is not needed for this web export.

Local presentation preview launched successfully on port 4001. HTTP smoke checks: `/demo`, `/demo/home`, `/demo-api/cases/A1` and `/demo-api/cases/D7` all return 200; the two cases contain 1,496 and 1,500 waveform points. This is a serving/data check, not a browser interaction check.

**Review focus:** dynamic layout and missing targets; small/landscape screens; cancellation during scroll animation; route changes; demo playback must never automatically start on tour dismissal.
