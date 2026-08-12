# Novelty & Originality — Red-Team Assessment

Adversarial review of TouchFree Vitals (TIENG). The job here is not to praise the
project; it is to find where a hostile judge, a reviewer, or a competitor would
break the novelty claim — and then to say what actually survives.

Scope of review: `Thyun` branch, full tree (~20k lines) plus `legacy/tieng_rppg/`
and the validation artifacts under `legacy/tieng_rppg/validation/`.

---

## 0. What the project claims

From `README.md` §1, the claimed differentiator is not measurement but the
**closed loop**:

```
센싱 → 품질 게이팅 → 상태 추정 → 개입 → 효과 검증 → (기준 갱신) → 센싱
```

and the signature feature is **L1** (`core/policy/l1_light.py`): commercial rPPG
SDKs tell the user "measure in a bright place"; this system *creates* that
condition itself.

Two claims must be defended separately:

- **C1 (architecture):** the closed loop + honesty contract is a new way to build
  this class of system.
- **C2 (evidence):** quality gating buys accuracy, and the loop demonstrably
  restores measurement.

**C1 largely survives. C2 does not currently hold up in your own data.**

---

## Part A — What is genuinely original

Ranked by how well each would survive a hostile reviewer.

### A1. Reversibility as a typed safety contract on the policy base class ★★★★☆

`core/policy/base.py` makes `reversible: bool` a required class attribute, and
the rule is architectural, not advisory:

> `reversible=True` 인 개입만 자동 실행한다. `reversible=False`(보호자 호출, 응급
> 에스컬레이션)는 지속 조건 + 품질 통과를 모두 만족해야 발화한다.

`core/policy/runner.py` then enforces the irreversible path structurally: `fire()`
does **not** send. It opens a cancel window; `evaluate()` sends only if nobody
cancelled (`l4_guardian.py:131-179`). The comment says why in one line:

> 카운트다운을 두는 이유: 메일은 되돌릴 수 없다. 새벽에 오작동으로 보호자를 깨우면
> 그 시스템은 다음 날 꺼진다. 한 번 꺼진 시스템은 진짜 필요할 때도 꺼져 있다.

This is the strongest idea in the repository. Undo-windows are old (Gmail undo
send), and staged clinical alarm escalation is old. What is uncommon is
**tiering automated health interventions by reversibility, declaring the tier on
the policy type, and having the scheduler — not the policy — enforce the
confirmation gate**. That is a reusable design pattern that generalizes past this
project, which is exactly what a novelty claim should look like.

### A2. `progress` and `confidence` as separate fields in the data contract ★★★★☆

`api/schemas.py` / `README.md` §2:

> `progress`는 **값이 나오기까지 얼마나 왔는가**다. `confidence`("지금 값이 얼마나
> 믿을 만한가")와 범위는 같지만 뜻이 다르다. […] 이 필드가 있어야 프론트가
> **"기다리면 나온다"와 "신호가 나빠서 못 낸다"를 구분**한다.

Both states are `state=low_quality`, and collapsing them is the standard failure:
every session opens with a quality warning during window fill, so users learn to
ignore the warning entirely. The fix is one float in the contract.

This is small, and that is the point — it is a genuine design contribution that
costs almost nothing and that most systems in this space get wrong. It is also
honestly scoped: `progress` is explicitly excluded from CSV because it is a screen
concept, not evidence.

### A3. Recording non-firing decisions, with a near-miss distinction ★★★☆☆

`runner.py:146-152` + `base.py:49-57`. Policies record *why they did not fire*,
and separate "conditions simply weren't met" from `near_miss` ("the main
condition held; something else blocked it"). Only near-misses reach CSV, so the
log doesn't drown.

This makes the hold rate a measurable quantity with a real denominator, which is
what turns "we hold when unsure" from a slogan into an auditable number.
`VALIDATION_PROTOCOL.md` §0 already commits to reporting accuracy and coverage as
a pair. That pairing discipline is rarer than it should be and is defensible as
methodological originality.

### A4. Confidence → expected-error calibration ★★★☆☆ (idea only — not wired in)

`legacy/tieng_rppg/confidence/confidence.py:524-596`:

> '0.7'이라는 값에 물리적 의미를 준다. 임계값을 눈대중이 아니라 목표 오차로부터
> 역산할 수 있게 하는 것이 이 클래스의 존재 이유.

`Calibration.fit` bins confidence against measured error, interpolates sparse
bins, then enforces monotonic decrease by **weighted isotonic regression** — with
a comment explaining why `np.minimum.accumulate` would be wrong. `threshold_for_mae`
inverts it: pick the gate from a target error instead of by eye. `coverage_curve`
produces the hold-rate-vs-MAE tradeoff curve.

Intellectually this is the best-argued piece of the project, and it is the right
answer to "why 0.5?" — the question you *will* be asked.

**But be careful making this a novelty claim:** it lives in `legacy/`, it is not
called from the active pipeline, and `core/quality.py` says the coefficients were
deliberately deferred pending re-measurement. Presenting it as a capability would
be overclaiming. Present it as the calibration method you will apply once the
oximeter data exists.

### A5. L1 — actuating the environment to repair sensing ★★☆☆☆ as novelty, ★★★★☆ as demo

This is your most *marketable* feature and your most *attackable* one. See C3 and
C4 below. As an idea it sits close to a well-established field (active
perception / controlled illumination in machine vision), and it currently has
zero real-hardware evidence.

### A6. Supporting engineering (real quality, low novelty)

Honest framing: these are craft, not originality. Do not lead with them.

- `core/registry.py` — config-driven dynamic load; adapter/actuator/policy all
  follow one rule; every failure is absorbed and downgraded to a `state`, so one
  dead sensor never stops the pipeline.
- `core/sim_room.py` — a shared virtual room so the mock actuator's light
  actually raises mock lux, which actually raises confidence. Closes the L1 loop
  without hardware. Nice, and explicitly marked dev-only.
- `quality.combine()` — weighted **geometric** mean, so one near-zero component
  cannot be averaged away, plus absent components dropped from the weight sum
  rather than defaulted to 0.5. Correct reasoning, standard technique.
- Privacy-by-construction: frames reduced to three numbers and discarded;
  preview encoded only while someone is watching; last frame dropped on camera
  fault so a dead feed can't masquerade as live (`rppg.py:217-224`).
- 148 tests, `guest/member/admin` with HttpOnly cookies chosen specifically
  because browser WebSockets can't carry headers (`api/auth.py`).

---

## Part B — What is not novel (expect to be challenged)

State these yourself before a judge does. Conceding known ground is what makes
the remaining claim credible.

| Component | Prior art |
|---|---|
| `_pos()` in `rppg.py:622` | POS — Wang et al., IEEE TBME 2017. Textbook rPPG. Also CHROM (de Haan 2013), ICA (Poh 2010). |
| The SQI formula in `quality.score()` | **Your own `HANDOFF.md` §7 states it is an implementation of the Dankook 2025 paper's Eq. 2.1–2.5.** This is a reimplementation, not an invention. Say so first. |
| rPPG quality indices / gating generally | An active published subfield. "Gate rPPG on signal quality" is not a new idea. |
| Thermal nostril respiration | Long-established thermography technique. |
| Bland–Altman reporting | Bland & Altman 1986, the standard for method agreement. |
| Non-contact vitals for eldercare | Crowded: Oxehealth (CE-marked, camera, care settings), Binah.ai, Nuralogix Anura; radar-side Vayyar Care, Google Nest Hub/Soli, MIT Emerald. |
| Environment automation on sensor thresholds | Ordinary home automation. |
| Actuating illumination to improve imaging | Active perception (Bajcsy 1988); controlled illumination is routine in industrial machine vision. |

**Consequence:** the measurement layer is entirely derivative and you should not
claim otherwise. Your novelty has to be argued one level up — at the loop, the
contract, and the honesty discipline. Fortunately that is where A1–A3 live.

⚠️ I have not run a patent or systematic literature search. Nothing above should
be filed or submitted as a formal originality claim without one.

---

## Part C — Attacks on the novelty claim

These are the ones that would actually hurt.

### C1. Your own validation data does not support the gating claim — it inverts it

This is the most serious finding in this review.

`VALIDATION_PROTOCOL.md` §0 sets H2 as the product core — "SQI 게이팅을 켜면 나쁜
구간이 제거되어 오차가 크게 준다" — with the §6 pass criterion for head_motion
being a reproduction of the paper's 13.4 → 2.89 direction.

From your own `legacy/tieng_rppg/validation/report/*/summary.csv`:

| session | all MAE | SQI≥0.50 | SQI<0.50 | gating direction |
|---|---|---|---|---|
| static1 | 3.65 | 3.65 | *(n=0)* | no comparison |
| static2 | 5.21 | **4.94** | 7.27 | ✅ works |
| static3 | 7.95 | 7.95 | *(n=0)* | no comparison |
| lighting1 | 4.54 | 4.59 | **4.13** | ❌ inverted |
| headmotion1 | 7.78 | 8.08 | **7.15** | ❌ inverted |
| headmotion1_raw | 13.99 | 14.35 | **13.14** | ❌ inverted |

**Gating helps in 1 of 4 comparable sessions, and it fails in the exact scenario
built to prove it.** In head_motion the low-quality frames are *more* accurate
than the passed ones — the SQI is anti-correlated with accuracy precisely where
it is supposed to earn its keep.

A judge who opens `summary.csv` finds this in about thirty seconds. If your
slide says "gating removes bad segments" while your repository says the
opposite, the honesty positioning — which is the whole product thesis — collapses
on contact.

### C2. The estimator does not beat a trivial constant predictor

The reference PR series barely move: SD ≈ 2.1–5.4 bpm across sessions, and only
54–61 bpm total range in head_motion. When the truth is nearly constant, MAE
mostly measures how far your estimate drifts from a fixed number — a degenerate
comparison.

I re-ran the comparison against the null model *"always output this subject's
mean resting HR"* (lag search ±5 s, 20 s oximeter warm-up excluded, matching your
documented pipeline; my camera MAEs land within ~0.5 bpm of your reported figures,
so the approximation tracks):

| session | ref SD | camera MAE | constant-baseline MAE | verdict |
|---|---|---|---|---|
| static_r1 | 5.33 | **3.21** | 4.35 | ✅ beats baseline |
| static_r2 | 5.43 | 5.14 | **4.47** | ❌ |
| static_r3 | 4.15 | 7.82 | **3.57** | ❌ |
| lighting_r1 | 3.13 | 4.59 | **2.37** | ❌ |
| head_motion_r1 | 2.11 | 7.30 | **1.90** | ❌ |

**The camera beats "guess the resting HR" in 1 of 5 sessions.** No scenario in
the protocol induces HR change, so there is currently no evidence in this
repository that the system *tracks* heart rate at all, as opposed to landing near
a plausible constant. `VALIDATION_PROTOCOL.md` §2 defines static / lighting /
head_motion — all resting. That is the gap.

This does not mean the rPPG is broken. It means the experiment as designed cannot
demonstrate that it works.

### C3. L1's success metric is partly circular

`quality.score()` computes `q_brightness = 1.0 if 45 ≤ brightness ≤ 220 else 0.5`,
weighted `W_BRIGHTNESS = 0.10`. So brightness crossing that boundary moves
confidence by **exactly 0.05 × q_motion — with no change in the pulse signal at
all.**

L1 fires at `confidence < 0.4` and verifies itself 20 s later by re-reading
confidence (`l1_light.py:105-118`). With the demo gate at 0.4, a measurement
sitting at 0.36–0.40 is pushed over the line **by the step term alone**.

The intervention can therefore manufacture its own success. The effect is
bounded and not fatal, but "we turned on the light and confidence recovered" is
not currently a clean causal claim.

**Fix, and it is cheap:** `Quality` already carries every component. Report the
change in `q_snr` — or confidence recomputed with `q_brightness` held fixed —
as the primary L1 outcome. If SNR genuinely improves, you have a real result and
a much stronger story. `l1_light.evaluate()` only needs to write the components
into `after`.

### C4. The signature feature has never run on real hardware

`sim_room.py` closes the L1 loop honestly, and its docstring is explicit that
live adapters do not use it. But that means the entire evidence base for the
signature feature is: mock light → mock lux → mock confidence.

The real chain — Tuya bulb → actual room lux → actual skin illumination →
actual rPPG SNR — is unmeasured. `README.md` §6 Phase 3 sets the right completion
bar ("불을 끄면 시스템이 스스로 켜고 confidence가 복구된다"); it has not been met.
Until it is, L1 is an architecture, not a result. A judge asking "did it actually
work in a room?" must not get a simulator as the answer.

### C5. N=1, single skin tone — and this specific gap is dangerous for *your* thesis

`VALIDATION_PROTOCOL.md` §5 already flags N=1 and Fitzpatrick diversity as a
recommendation. Red-team framing of why it matters more here than usual:

rPPG is known to be skin-tone sensitive. Your product thesis is *honest
abstention*. If the gate holds systematically more often for darker skin, the
system does not fail loudly — it goes quiet, and quiet reads as "fine." A safety
mechanism that degrades to silent non-coverage for one group is an equity failure
wearing the costume of caution.

You cannot fix this before the deadline. You can name it as a known limitation and
as required future work, which is both honest and protective.

### C6. Two divergent quality paths, one of them a documented failed migration

`core/quality.py` carries `score()` (visible-light rPPG, weighted arithmetic
mean) and `score_signal()` (sensor-neutral, weighted geometric mean). HR uses the
old one; RR/thermal uses the new one. The docstring documents the attempted
migration and its rollback, with a comparison table showing normal faces getting
held at 0.38–0.47.

This is exemplary engineering honesty. But it undercuts the "sensor-neutral
quality layer" framing — that unification is designed, half-built, and blocked on
oximeter re-measurement. Claim it as an architecture, not an achievement.

### C7. Smaller items

- **Thermal is entirely provisional.** `MIN_ROI_PIXELS = 4`, `MIN_DELTA_T = 0.5`,
  and a fixed `DEFAULT_NOSTRIL_ROI = (13, 9, 6, 5)` in 32×24 coordinates, marked
  "※ 실장비가 없어 잠정값이다." The ROI does not track the face — the subject must
  sit in one spot. `thermal_mlx90640.py:84-86` explains the tradeoff honestly.
  Demoing RR as a working modality would be overclaiming.
- **`README.md` is UTF-16LE with CRLF**, while every other file is UTF-8. It
  renders as mojibake in most viewers and diffs as binary (`Bin 0 -> 20 bytes` on
  `main`). If a judge browses the repo, the first file they open is broken. One
  `iconv` fixes it.
- **`main` contains only a 20-byte README.** All work lives on `Thyun` / `Justin`.
  If anyone is pointed at the repository root, the project looks empty.

---

## Part D — How to make the claim defensible

Ordered by value per unit effort.

1. **Change the headline claim from accuracy to abstention.** You cannot
   currently claim gating improves MAE — your data says otherwise in 3 of 4
   sessions. You *can* claim the system refuses to display values it cannot
   justify, and that every refusal is logged with a reason. That claim is fully
   supported by the code, is the actual product thesis (`HANDOFF.md` §1), and is
   what A1–A3 deliver.

2. **Report C1 yourself, on a slide.** "We tried to reproduce the paper's gating
   effect and did not — here is our data, here is our hypothesis for why (N=1,
   near-constant reference, gate tuned on a different subject)." A team that
   reports a failed replication of its own core hypothesis is far more credible
   than one that quietly ships the favorable subset. It also converts your
   biggest vulnerability into a demonstration of the exact discipline you are
   selling.

3. **Run one session with HR variation** — light exercise, then seated recovery,
   a 60–100 bpm ramp with the oximeter on. This is a single afternoon and it is
   the highest-value missing datum in the project. It is the only way to answer
   C2, and a visible tracking curve is a far better slide than any error table.

4. **Decompose the L1 effect metric (C3).** Report Δ`q_snr`, not Δconfidence.
   Small code change in `l1_light.evaluate()`, removes the circularity objection
   completely.

5. **Do L1 once for real, and film it.** Lamp off → confidence falls → system
   turns the light on → confidence recovers, with the CSV alongside. That video
   is the whole pitch. Until it exists, C4 stands.

6. **Fix the README encoding and put something on `main`.** Ten minutes.

7. **Pre-concede Part B in the deck.** One line: "POS is Wang 2017, the SQI is
   our implementation of [paper]; what is ours is the intervention loop and the
   abstention contract." This inoculates against the strongest attack — being
   caught claiming someone else's algorithm.

---

## Verdict

**The measurement is not novel and should not be claimed as such.** POS, the SQI
formula, thermal respiration, and non-contact eldercare monitoring are all
established, and one of them is explicitly a reimplementation of a cited paper.

**What is defensibly original is the control and safety layer:** reversibility as
a typed contract with scheduler-enforced confirmation for irreversible actions
(A1); the `progress`/`confidence` split that separates "not ready" from "not
trustworthy" (A2); and treating non-decisions as first-class logged evidence so
abstention becomes measurable (A3). These are real, they are implemented, they
are tested, and they generalize beyond this project.

**The empirical claims are not currently supported.** Gating inverts in 3 of 4
comparable sessions, the estimator beats a constant predictor in 1 of 5, the
signature L1 feature has only ever run against a simulator, and its success
metric is partly self-fulfilling.

The good news is that the project's own documentation — `HANDOFF.md` §1 and §5,
`VALIDATION_PROTOCOL.md` §6 — already anticipates most of this and says target
misses are not failures. Follow that instinct all the way: lead with the
architecture, report the failed replication as a finding, and get one
HR-varying session plus one real L1 demo on record. That combination is both
honest and considerably more persuasive than the accuracy claim you cannot yet
make.
