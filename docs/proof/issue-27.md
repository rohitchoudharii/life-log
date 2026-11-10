# Issue #27: Write fresh questions before ideas come back

Release 5, task 22 of 31. Spec: `learning_spec.md` sections 5.3, 6.3 and 7.3 (top-ups).

## What was built

- **The `top-up-questions` job.** For one member, it finds the cards that would otherwise be asked through their cue again when they come back, and writes one fresh question for each (`apps/server/src/learning/top-up.ts`). A card qualifies when all of these are true:
  - it is a key idea or saved idea from a reading, started and not removed;
  - it is due within the next 2 days, or already due;
  - every one of its active questions has been asked (each has an answer in `review_log`);
  - none of its questions was written in the last 7 days.
- **The new question is at the card's level** (explain at least, since the cue already asks for recall). It is written in the member's kinds, passes the same checks in code and the same quality check as a section's first questions, and must not repeat or reword any question asked on that idea before. It is stored with the card's reading and section.
- **Cost limits from the spec:** at most 8 cards per AI call and 3 calls per run, soonest due first. The budget is checked before each call. The job is skipped without a key, past the monthly budget, and on **Quick**, where ideas are meant to come back through their cues.
- **When it runs:** every 6 hours for each member with a key (`top-up-all`, scheduled with pg-boss), and 5 minutes after Review answers. Answers in one sitting share one queued job (a singleton key per member), so a Review session costs at most one run.
- **LLM:** `writeQuestions` now takes several sections, a level per idea, and how many questions per idea, so Rewrite questions and top-ups share it.

## Decisions for the learner

- **Varied retrieval when it matters.** A question is written only for a card due within 2 days that has nothing new to ask. A card whose questions were all asked would otherwise get its cue again and again, and the answer could come from memory of the question rather than of the idea.
- **No work for lessons.** A lesson has no text to write a question from, so it keeps its cue, which the member wrote or chose.
- **A failed top-up changes nothing the member sees.** The card is asked through its cue, as before.

## Proof

There is no new screen: this work happens before the member opens Review. When a topped-up card comes back, Review picks the new question, which is the behaviour the #19 and #26 e2e tests already cover.

### Tests

- `apps/server/src/learning/top-up.test.ts` (integration, against Postgres, with the test site as the AI provider):
  - **picks started cards due within 2 days whose questions were all asked and none written in the last 7 days**: of six cards, it picks the overdue one and the one due in 1.5 days, soonest first. It leaves out a card due in 5 days, one with an unasked question, one given a question 3 days ago, and one not started.
  - **writes one fresh question at the card's level for a card due in 2 days with no unasked question**: a card at level 2 gets one new `apply` question; it is not topped up again within 7 days.
  - **is skipped without a key, on Quick, and past the monthly budget, with no AI call**.
- `packages/llm/src/write-section.test.ts`, the Rewrite test now goes through the shared `writeQuestions` with a section index per idea.

Full run: `pnpm typecheck`, `pnpm test` and `pnpm e2e` (142 passed, 32 skipped) are green.
