# Tasks

Plan only. Nothing here is built yet.

## 1. Rethink how quizzes get created

**Status:** noted. We will design this later. We want to rethink the whole decision about when and how questions get written, not patch the current flow.

### How it works today

- Questions are written only in **Manage test** (`apps/mobile/src/app/manage/[id].tsx`). Nothing is written until the learner picks sections and taps **Generate quiz**.
- Manage test is three taps deep: the reader's pill, then **More**, then **Manage test**. The library row menu also opens it.
- After **Generate quiz**, `onSuccess` calls `router.back()`, so the learner lands back in the reader, not in the test. Nothing tells them when the questions are ready.
- **Test me** on a reading with no questions shows "No questions yet" and a single **Manage test** button (`apps/mobile/src/app/test/[id].tsx`). Sections without questions are greyed out in the picker.
- When a focus session ends, it opens `/test/[id]?afterSession=1`, which hits the same "No questions yet" screen when nothing has been written.
- Today's empty state says Life Log Club "splits it into sections and writes questions for each" (`apps/mobile/src/app/(tabs)/index.tsx`). That is not true today.
- Generating needs the learner's own AI key. The button is disabled without one, so a new user can't try the loop before setup.
- **Generate and replace** deletes a section's questions along with their review history.
- Settings: **How hard** (the user default is `thorough`) and **Style** (`mixed`), stored per reading on `content_items`.
- Generation runs as a pg-boss job (`apps/api/src/jobs.ts`), and `item.status` is `processing` while it runs.
- The brain dump does not need questions. `POST /recall` extracts a section's key ideas on its own when they are missing (`apps/api/src/routes/recall.ts`).

### What we want

- The time between "I finished reading" and the first act of recall should be zero screens.
- The learner never has to remember to generate anything.
- Settings stay available to people who care, without blocking people who don't.
- No surprise loss of review history.

### Options to decide between

1. **Write on first Test me.** Tapping **Test me** on a section with no questions starts generation and goes straight to the brain dump. Writing takes 3 to 5 minutes, which covers the generation time. If questions aren't ready when the dump ends, show "Your questions are almost ready" and let them stream in.
2. **Write when a section is finished.** When the learner reaches the end of a section in the reader, queue Quick questions in the background, so they're ready before **Test me**.
3. **Write on import.** Generate for every section when a reading is added. It's the simplest, but it spends AI calls on sections the learner may never read.
4. **A mix.** Option 2 for sections that are read, option 1 as the fallback, and Manage test becomes an advanced screen for regenerating questions or changing How hard and Style.

### Open questions

- Should automatic writing default to **Quick** (cheap, key ideas only) or to the user's default from Settings?
- How do we show cost, given that today Manage test shows "about N questions · uses your AI key" before spending?
- What does a learner without an AI key see? Proposed: a sample reading with questions already written, so the loop works on day 0.
- Regenerating: keep the history of ideas that survive the rewrite, or keep the current replace-all behaviour behind a clearer warning?
- Ideas race. The brain dump can create a section's ideas, and the generation job deletes and re-inserts ideas for the sections it writes (`jobs.ts`, `out.ideas`). Check that the two can run together without breaking recall results that point at idea ids.

### Files involved

`apps/mobile/src/app/manage/[id].tsx`, `apps/mobile/src/app/test/[id].tsx`, `apps/mobile/src/app/read/[id].tsx`, `apps/mobile/src/app/(tabs)/index.tsx`, `apps/api/src/routes/library.ts` (`generateQuiz`), `apps/api/src/jobs.ts`, `apps/api/src/routes/recall.ts`.

## 2. Guess first (typed guess and how sure you are), as a quiz setting

**Status:** built, not committed. Renamed from "Commit first", which was unclear. A right answer marked **Guessing** is spaced like **hard** (`withConfidence` in `packages/core/src/questions.ts`). Not used for vocabulary.

- A setting called **Guess first**, off by default. Its description in the app: "Type your guess before you see the choices, then tap how sure you are." The learner can turn it on or off on the test picker before starting, on the Review start screen, and in **Settings → Questions**. It's one user preference, so all three switches show the same value.
- When it's on:
  - **Multiple choice:** the options stay hidden behind a one-line field, "Your answer in a few words." **Show options** is disabled until something is typed. The guess appears above the options and again on the results.
  - **Every answer:** **Next** is replaced by three submit buttons, **Guessing**, **Think so**, and **Sure**. Picking one submits and moves on, so it adds about a second. **I don't know** stays.
  - **Results:** a "You were sure about these" group comes first and lists answers marked Sure that were wrong. Under the heading is a line like "Sure: 4 of 5 right · Think so: 2 of 3 · Guessing: 1 of 2".
- Data: add `users.guess_first` (boolean, default false) and `review_log.confidence` (nullable). The MCQ guess can be kept inside the stored `response` JSON.
- Decided: a correct answer marked **Guessing** is spaced like **hard**, so lucky guesses don't push an idea far out. Confidence only ever lowers credit, never raises it.
- Files: `apps/mobile/src/practice.tsx`, `apps/mobile/src/question-settings.tsx`, `apps/mobile/src/app/test/[id].tsx`, `apps/mobile/src/app/(tabs)/review.tsx`, `apps/mobile/src/app/(tabs)/settings.tsx`, `apps/api/src/routes/study.ts` (`/answers`), `apps/api/src/routes/me.ts`, `apps/api/src/db/schema.ts`, plus a migration.

## 3. Feedback after each answer in Review

**Status:** built, not committed. Review only; vocabulary keeps end-of-session feedback.

Today both a fresh test and a Review show every answer only after **Finish**. The change is for Review only: each answer is checked and its result is shown right after you submit it. Fresh tests keep end-of-test feedback, so earlier answers can't hint at later ones.

- **Why:** in a long Review, a mistake on question 1 is shown many minutes later, after the learner has forgotten why they answered that way. A wrong multiple-choice option that is not corrected soon can be learned as if it were true.
- **Flow in Review:** answer → **Check answer** (or the Guess first buttons, when that setting is on) → the result tile (verdict, answer key, next review) → **Next question**. After the last one, a summary screen with the same **Retry missed ideas** and **Done** as today.
- **Previous** goes away in Review, because each answer is final once checked.
- **Cost:** a written answer waits a few seconds for the AI judge. Choice answers are checked at once.
- Mockup: "Item 3: Review feedback, today and proposed" in this thread's artifacts.
- Decided: vocabulary (`words.tsx`) does not get per-answer feedback or Guess first.
- Files: `apps/mobile/src/practice.tsx` (a mode on `PracticeSession`), `apps/mobile/src/app/(tabs)/review.tsx`.
