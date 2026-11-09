# Issue #18: Move existing cards to the new scheduler

Release 2, task 13 of 31. Spec: `learning_spec.md` section 5.4.

## What was built

- **The new scheduler is on.** `defaultScheduler` is now `stepsThenFsrs()` (1, 2 and 3 day steps, then FSRS-6 at the member's target recall, capped at 365 days). Every answer uses it, and every new log row says `scheduler: 'steps-fsrs-v1:FSRS-6'` with the predicted recall just before the answer.
- **The old scheduler is gone.** `stepsThenEase` and its `ReviewState` shape are deleted. Its callers (`ideas.ts`, the `cards.state` column type, the question tests) now use `SchedulerState`, so there is one scheduler and one state shape in the code.
- **`replaySchedule(answers, scheduler)`** in `packages/domain/src/scheduler.ts`: a card's state and due time, worked out again from its logged answers in order. It follows the same rule as a live answer: a right recall answer to a card that is not due yet (a second question on the same idea in one sitting) changes nothing, and a wrong answer always counts. Review answers always count, because the server only takes them when the card is due.
- **`replaySchedules()`** in `apps/server/src/learning/replay.ts`, run as the owner. For every card it reads its answers (practice answers left out, since they never moved the schedule), replays them, and writes `state`, `due_at`, and `started_at` when it was missing. Cards with no answers get the initial state and keep their due time. Levels are kept, because the recall check sets a card's starting level and the log does not hold it. Log rows are never changed. It returns a report to check against the acceptance:

  | Field | Meaning |
  | --- | --- |
  | `cards` | Cards looked at |
  | `replayed` | Cards with answers, whose schedule was worked out again |
  | `graduated`, `graduatedWithMemory` | Started cards past the steps, and how many have an FSRS memory (all should) |
  | `dueBefore`, `dueAfter` | Started cards due now, before and after |
  | `dueAtChangedInSteps` | Cards still in the steps whose due time changed (should be 0: the steps are the same in both schedulers) |

- **`pnpm db:replay-schedules`** (`apps/server/src/cli/replay-schedules.ts`) runs it on every card and prints the report. To try it on a copy, point `DATABASE_OWNER_URL` and `DATABASE_URL` at the copy.
- **The server replays old cards on start.** If any card still has the old state shape (no `memory` key), `main.ts` replays just those before it takes requests, so a server never answers a card with a state the new scheduler cannot read.
- **Count it as right on an old answer.** Changing an answer replays the card's later answers from the state saved with that answer. An answer saved under the old scheduler holds an old-shape state, so it is now refused with "This answer is too old to change.", the same message as an answer saved before states were kept.

## A bug found on the copy, and fixed

The first replay skipped every right answer given before the card was due under the new schedule. That is right for recall answers, but wrong for review answers: the server took each of them only when the card was due under the old scheduler. For a graduated card, FSRS can give a longer gap than the old ease rules, so the first version would have dropped real, on-time reviews and left those cards with fewer answers than the member gave. The rule now applies to recall answers only. A unit test covers it: four Got its, then a review at day 14, which is before the FSRS due time but on time for the old rules, and the replay counts all five answers. With the old rule the test fails (4 answers counted).

## Proof

### Copy of the e2e database

`create database lifelog_replay_e2e template lifelog_e2e`: 149 cards, all in the old shape.

| Run | Report | Cards checksum (md5 of id, state, due_at, started_at) |
| --- | --- | --- |
| 1 | `cards 149, replayed 76, graduated 1, graduatedWithMemory 1, dueBefore 17, dueAfter 14, dueAtChangedInSteps 2` | `39339c3b156a67c9f20638b471bf0955` |
| 2 | `cards 149, replayed 76, graduated 1, graduatedWithMemory 1, dueBefore 14, dueAfter 14, dueAtChangedInSteps 0` | `39339c3b156a67c9f20638b471bf0955` |

- **Idempotent:** the second run writes the same rows (same checksum) and finds nothing to change.
- **Every graduated card has a memory:** 1 of 1.
- **`due_at` equals the replay result:** the second run changes no due time.
- **The 2 cards in the steps whose due time changed, and the 3 cards no longer due**, were all made due by the e2e tests themselves: the specs update `cards.due_at` directly (`makeDue` in `e2e/mind-read.spec.ts`) so a card can be answered again in seconds, and the log does not record that. Each of these 3 cards has an old due time earlier than its last answer, which no scheduler can produce, since every gap is longer than zero. A script over the old rows confirmed that exactly these 3 cards have that, and that they are exactly the 3 whose "due now" changed. So on real data, where due times only come from the scheduler, cards in the steps keep their due times and the due totals change only for graduated cards, as the acceptance asks.

### The owner's local database

The owner's local `lifelog` database had 1 member and 0 cards, so the replay has nothing to move there. It was first run on a copy (`lifelog_replay_copy`), then on `lifelog` itself, twice each: every report was all zeros and the checksum did not change.

Before the replay could run, it showed a separate local problem: **migrations 0017 and 0018 had never been applied to the local `lifelog` database**, so `pnpm dev` against it could not have worked. Migration 0016 was applied locally in its first version and then generated again before it was committed; the committed version adds one more column (`review_log.reveal`) and has a later timestamp. Drizzle applies every migration newer than the last applied timestamp, so it tried 0016 again and failed on the column that was already there. The fix, on the copy first and then on `lifelog`, in one transaction: add the missing `review_log.reveal` column, and set the bookkeeping row for 0016 to the committed file's hash and timestamp. After that, 0017 and 0018 applied on the next start. Nothing was deleted. The committed migrations did not change, so no other database is affected.

### Tests

- `packages/domain/src/scheduler.test.ts`: replaying good ×4, each when due, gives the 1, 2 and 3 day steps, then an FSRS gap, and the same result as answering live; the same answers replay the same every time; a right recall answer before the card is due is skipped but a wrong one is not; a review answer the old rules took counts even when the new rules would have it due later.
- `apps/server/src/learning/replay.test.ts`: against Postgres, a graduated card, a card in the steps with no start time, a card with no answers, and a same-sitting pair of recall answers are replayed. It checks the report, every written row, that practice answers and log rows are untouched, and that a second run changes nothing.
- `e2e/review.spec.ts`: a member answers Got it four times; the gaps are 1, 2 and 3 days, then a gap from FSRS, the card leaves the steps with an FSRS memory, and each log row names `steps-fsrs-v1:FSRS-6` with a predicted recall once the card has been answered.

Full run: `pnpm typecheck`, `pnpm test` and `pnpm e2e` are green. Nothing a member sees changes in this issue, so there are no screenshots.
