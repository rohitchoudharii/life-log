# Issue #17: Schedule with 1-2-3 day steps, then FSRS

Release 2, task 12 of 31. Spec: `learning_spec.md` sections 5.1 and 5.2.

## What was built

- **`stepsThenFsrs`** in `packages/domain/src/scheduler.ts`, behind the `Scheduler` type. It is built and tested but **not switched on yet**: cards still use `stepsThenEase` until the replay in #18 moves them.
- **Steps, as today:** Got it moves from 1 day to 2 days to 3 days. Hard repeats the step's gap without moving on. Forgot starts the steps over and brings the card back in 10 minutes.
- **Graduation:** after the 3-day step, each gap comes from FSRS at the member's target recall (default 90%), capped at 365 days.
- **FSRS memory on every answer**, the steps included. The card's state keeps FSRS's stability and difficulty, so FSRS knows the card well when it graduates.
- **The lapse rule (changed from today):** a graduated card that is forgotten comes back in 10 minutes, then 1 day, then FSRS again, not all three steps. FSRS has already cut its stability, so three fixed reviews would be wasted work. Hard repeats the 10-minute or 1-day gap. The lapse counts once.
- **Fuzz:** FSRS gaps of 3 days or more are spread by FSRS's own fuzz ranges (up to 15% for gaps up to 20 days, 5% beyond). The seed is the card's answer count, the time and its stability, so ideas learned together drift apart, and the same answers replayed give exactly the same gaps (the #18 replay depends on this).
- **`retrievability(state, now)`** on every scheduler: the predicted chance of recall now, from the FSRS forgetting curve. Null for a card never answered, and always null for `stepsThenEase`, which has no model of forgetting.
- **The scheduler's id in every answer.** Each scheduler has an `id` (`steps-ease-v1`, or `steps-fsrs-v1:FSRS-6` for the new one). `review.answer` now writes it into `review_log.scheduler`, and writes the scheduler's predicted recall just before the answer into `review_log.predicted_recall` (null until FSRS is on).
- **Library:** `ts-fsrs` 6.0.0, its FSRS-6 model (`ts-fsrs/models/fsrs-6`) with the default weights. Only its memory update, interval and forgetting curve are used; the 1-2-3 day steps and the lapse rule are ours, so nothing depends on how the library handles day-length steps.

## Decisions

- **FSRS-6, not the library's newer FSRS-7 default.** FSRS-6 is the model the spec names, its weights are the published defaults, and the old FSRS class is deprecated in this version of the library while the FSRS-6 model is not.
- **Short-term stability is off.** It is for reviews minutes apart; here only the 10-minute retry is that close.
- **Elapsed time counts whole days**, as FSRS's own scheduler does, so a review 23 hours later counts as the same day.
- **Easy stays possible**, from grading only, and skips a step as it does today.

## The gaps, as the code gives them (fuzz off, 90% target)

| Answers | Gaps |
| --- | --- |
| Got it ×6 | 1 d, 2 d, 3 d, then FSRS: 28 d, 105 d, 337 d |
| 4× Got it, then Forgot, then Got it ×3 | 1 d, 2 d, 3 d, 28 d, then 10 min, 1 d, then FSRS: 4 d, 11 d |
| Got it, Forgot in the steps, then Got it ×3 | 1 d, 10 min, then the steps again: 1 d, 2 d, 3 d |

The 5th gap after five Got its, by target: 80% → 365 d (the cap), 85% → 281 d, 90% → 105 d, 95% → 26 d.

## Proof

Unit tests (in `packages/domain/src/scheduler.test.ts`):

- **Got it four times gives 1, 2 and 3 days, then a gap from FSRS at 90% recall.** The 4th gap is over 3 days, and the predicted recall at that gap is between 88% and 92%.
- **Updates the FSRS memory on every answer, the steps included.** Memory after the first answer; stability grows over the steps; no prediction before any answer.
- **In the steps, Forgot starts over in 10 minutes and Hard repeats the gap without moving on.** Got it then Forgot: 1 day, 10 minutes, back at step 1 with no lapse. Got it, Hard, Got it: 1, 1, 2 days.
- **A lapse after graduation comes back in 10 minutes, then 1 day, then from FSRS, and counts once.** Forgot, Forgot, Got it, Hard, Got it: 10 min, 10 min, 1 day, 1 day, then an FSRS gap shorter than before the lapse; one lapse; graduated again, not back in the steps.
- **Never schedules more than 365 days ahead, with or without fuzz**, and never past a lower cap when one is set.
- **A higher target recall gives shorter gaps.**
- **Fuzzes FSRS gaps by up to 15%, the same way each time for the same answers.** The same answers give the same gaps; cards answered a minute apart spread around the plain gap; the steps are never fuzzed.

Full run: `pnpm typecheck`, `pnpm test` (186 tests) and `pnpm e2e` (119 passed, 25 skipped) are green. Nothing a member sees changes in this issue, so there are no screenshots.
