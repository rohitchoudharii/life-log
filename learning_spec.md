# Life Log Club: learning spec (Mind pillar)

**One line:** read, bring back what you read, and keep it, with as few clicks as the rest of the app.

This is the product and technical spec for the next stage of the Mind pillar on the web app. It builds on the base frame (commits `d6b2416..01d4a55`) and reuses the old Peak app (deleted in `4051df5`) where that code is already tested. It decides the three open tasks from the old task list (`git show 011e12e:task.md`): old task 1, when questions get written; old task 2, Guess first; and old task 3, feedback after each answer in Review.

Voice capture, the phone app and the Chrome extension come later. Where the design keeps room for them, it says so.

## Contents

1. [Decisions at a glance](#1-decisions-at-a-glance)
2. [Learning science basis](#2-learning-science-basis)
3. [The loop](#3-the-loop)
4. [Core data model](#4-core-data-model)
5. [Scheduler decision](#5-scheduler-decision)
6. [How AI is used, and where it is not trusted](#6-how-ai-is-used-and-where-it-is-not-trusted)
7. Features
   - [7.1 Adding readings](#71-adding-readings)
   - [7.2 Reader and sections](#72-reader-and-sections)
   - [7.3 Key ideas and questions: when they get written (old task 1)](#73-key-ideas-and-questions-when-they-get-written-old-task-1)
   - [7.4 Recall check: brain dump, then questions](#74-recall-check-brain-dump-then-questions)
   - [7.5 Question types](#75-question-types)
   - [7.6 Grading](#76-grading)
   - [7.7 Review queue and feedback (old task 3)](#77-review-queue-and-feedback-old-task-3)
   - [7.8 Confidence and Guess first (old task 2)](#78-confidence-and-guess-first-old-task-2)
   - [7.9 Saved ideas and mental-model cards](#79-saved-ideas-and-mental-model-cards)
   - [7.10 Life lessons in the same queue](#710-life-lessons-in-the-same-queue)
   - [7.11 Vocabulary](#711-vocabulary)
   - [7.12 Teach-back](#712-teach-back)
   - [7.13 Books as goals, finished books as milestones](#713-books-as-goals-finished-books-as-milestones)
   - [7.14 Skills and deliberate practice](#714-skills-and-deliberate-practice)
   - [7.15 Mind dashboard and the Home card](#715-mind-dashboard-and-the-home-card)
   - [7.16 Progress view](#716-progress-view)
8. [Metrics that show the learning works](#8-metrics-that-show-the-learning-works)
9. [Reuse map](#9-reuse-map)
10. [Release plan](#10-release-plan)
11. [Risks](#11-risks)
12. [Open questions for the owner](#12-open-questions-for-the-owner)
13. [Changes to earlier decisions](#13-changes-to-earlier-decisions)
14. [References](#14-references)

---

## 1. Decisions at a glance

| Question | Decision | Why, in short |
| --- | --- | --- |
| When are questions written? (old task 1) | **Option 4, changed.** A section's key ideas and questions are written in the background once the learner has spent 30 seconds in it. **Recall** is the fallback: it starts writing at once and opens the brain dump, which needs no questions. Manage test goes. Its settings move to Settings → Questions, plus one **Rewrite questions** action per section. | Zero screens between "finished reading" and recall. Nothing to remember to generate. Calls are spent only on sections someone actually reads. |
| Default amount | **Standard: one question per key idea**, written answers only until multiple choice arrives with Guess first (Release 4). | Each idea has its own schedule, so one question per idea is the unit that matters. Review writes more later, only for ideas that need them. |
| Showing cost | No confirm dialog. Settings → AI shows calls, tokens and an estimated cost this month. A monthly budget (default $5) pauses background writing when it is reached. | A dialog before every section breaks the one-click rule. A budget protects the member's key. |
| Member without an AI key | A sample reading with its ideas and questions already written, so the whole loop works on day 0. Without a key, written answers and brain dumps are checked by the learner against the model answer's checklist. | The loop must work before setup. Self-checking against a checklist is still retrieval with feedback. |
| Regenerating | Never deletes review history. **Rewrite questions** retires questions; their answers stay in `review_log`. Key ideas that have a schedule are never replaced. The learner edits them or adds missing ones. | Old task 1: "No surprise loss of review history." It also removes the ideas race. |
| Unit of scheduling | **One card per idea.** A key idea, a saved idea, a lesson and a word are all `cards`. Questions hang off cards and vary between reviews. | Reused from old commit `ea25e6f`, which fits the base frame's `cards` table. |
| Scheduler | **Hybrid: fixed steps of 1, 2 and 3 days, then FSRS** with a 90% retention target, capped at 365 days. Existing `review_log` rows are replayed to build FSRS state. | The owner asked for 1-2-3. Successive-relearning evidence supports three spaced recalls. FSRS predicts recall better than SM-2-style ease on large datasets. |
| Guess first (old task 2) | Keep it, and change two things. Confidence buttons are always shown on graded questions; they replace **Next**, so they add no click. The typed guess before multiple-choice options is **on by default**, and ships with multiple choice in Release 4. | Hypercorrection and calibration need confidence. Generating before seeing lures avoids learning a wrong option. |
| Per-answer feedback (old task 3) | Keep it: each Review answer shows its result at once. The recall check right after reading keeps end-of-set feedback. Vocabulary now gets per-answer feedback too, because it shares the queue. | In Review the items come from different readings, so one answer can't hint at the next. After reading, questions on one section can. |
| Streaks, daily caps, reminders | None. Review shows 20 at a time with **Keep going**. | Vision: not tied to a schedule. |
| Focus sessions (old Peak timer) | Dropped. Reading time is recorded quietly instead. | The vision doesn't ask for them, and they add a step. |

---

## 2. Learning science basis

Each principle gives what the evidence says, how strong it is, and what it means for the design. Full references are in [section 14](#14-references). Effect sizes are quoted only where the source was checked. Where evidence is weak or mixed, the table says so.

| Principle | What the evidence says | Strength | What it means here |
| --- | --- | --- | --- |
| **Retrieval practice (testing effect)** | Taking a free-recall test on a prose passage led to better retention after a delay than restudying, though restudy did better on a test 5 minutes later (Roediger & Karpicke, 2006). Retrieval beat concept mapping by d = 1.50 on a final short-answer test, and students predicted the opposite (Karpicke & Blunt, 2011). Practice testing rated "high utility" (Dunlosky et al., 2013). Classroom quizzing g = 0.499 across 222 studies (Yang et al., 2021). | Strong | Recall is the main act, not an extra. Every reading ends in recall; every card is answered from memory before the answer shows. |
| **Spacing; expanding vs equal gaps** | The best gap grows with how long you must remember (Cepeda et al., 2006; Cepeda et al., 2008). Expanding gaps helped at 10 minutes, but equal gaps did better 2 days later; delaying the first test was what mattered (Karpicke & Roediger, 2007). Meta-analysis: spaced beat massed retrieval (g = 0.74); expanding vs uniform made no reliable difference (g = 0.034), with expanding doing better as the number of tests rose (Latimier et al., 2021). | Strong for spacing; mixed for expanding vs equal | Fixed 1-2-3 day steps (near-uniform), then gaps set by predicted recall rather than a fixed growth rule. We make no claim that expanding gaps are better in themselves. |
| **Successive relearning** | Recall to 3 correct, then relearn 3 times at widely spaced intervals, gave durable learning for a small extra cost (Rawson & Dunlosky, 2011). | Moderate (lab and classroom material, short answers, hand-scored) | Supports the owner's 1, 2 and 3 day steps as the start of every idea's life. |
| **Generation effect; free recall vs recognition** | Generating beat reading by about d = 0.40 across 86 studies (Bertsch et al., 2007; Slamecka & Graf, 1978). Initial recall tests gave larger testing benefits than recognition tests (Rowland, 2014). But multiple-choice practice tests also showed large effects (g = 0.70), and mixed formats the largest (g = 0.80) (Adesope et al., 2017). | Strong for generation; mixed for format | Brain dump first, written answers before options, Guess first before options. Multiple choice stays, as a minority, with feedback. |
| **Elaborative interrogation and self-explanation** | Prompting students to self-explain after each line of a text improved understanding (Chi et al., 1994). Both techniques rated "moderate utility": promising, but not well tested in classrooms, and durability "woefully underexplored" (Dunlosky et al., 2013). Learning by teaching has been studied (Fiorella & Mayer, 2013); we did not verify its effect sizes. | Moderate; weak for AI "students" | Questions ask why and how, not "define". Teach-back is offered after a miss, not forced. We do not claim an AI student works as well as a human one. |
| **Interleaving** | Mixed practice of maths problems beat blocked practice a week later (Rohrer & Taylor, 2007). Meta-analysis g = 0.42 overall, but results were ambiguous for expository texts and blocking won for word lists (g = −0.39) (Brunmair & Richter, 2019). | Mixed; weak for text | Review mixes readings mostly because spacing and per-idea schedules already do. We don't sell interleaving as a benefit for text or words. |
| **Desirable difficulties** | Conditions that slow learning during practice (spacing, testing, variation) can improve long-term retention (Bjork, 1994; Bjork & Bjork, 2011). They are desirable only if the learner can meet them; without the background, difficulty stops helping. | Strong as a framework | Questions get harder as an idea is recalled (recall → explain → apply → analyse → transfer) and easier after a miss. |
| **Feedback timing** | In the lab, delayed feedback after a multiple-choice test beat immediate feedback (Butler, Karpicke & Roediger, 2007). Across 53 studies, classroom studies favoured immediate feedback and lab studies of test content favoured delay (Kulik & Kulik, 1988). Both immediate and delayed feedback reduced learning of wrong options (Butler & Roediger, 2008). | Mixed on timing; strong that feedback matters | Feedback always comes. In Review it comes per answer. After reading, at the end of the set. See [7.7](#77-review-queue-and-feedback-old-task-3). |
| **Multiple-choice lures** | Reading more wrong options raised the chance of later giving them as answers (Roediger & Marsh, 2005); the effect was still there a week later (Fazio et al., 2010). Feedback reduces it (Butler & Roediger, 2008). | Strong | Guess first, `whyWrong` for every option, and feedback after every choice answer. |
| **Hypercorrection and confidence** | Errors made with high confidence were the most likely to be corrected on a retest after feedback (Butterfield & Metcalfe, 2001; Metcalfe, 2017). | Strong in the lab, mostly general-knowledge facts | Ask confidence before showing the answer. List "You were sure about these" first. No extra penalty: feedback does the work. |
| **Pretesting and errorful generation** | Unsuccessful retrieval attempts improved later learning of the answer (Kornell, Hays & Bjork, 2009; Richland, Kornell & Kao, 2009). The benefit is real but varies by procedure (Pan & Carpenter, 2023). It did not spread to information that was not pretested (James & Storm, 2019). | Moderate; item-specific | Guess first, and a "Nothing comes to mind" option for an honest empty dump. We do **not** add questions before reading, because the gain is item-specific and costs clicks. |
| **Metacognition and judgments of learning** | Learners judge their learning from fluency while the answer is in front of them, which inflates confidence (Koriat & Bjork, 2005; Bjork, Dunlosky & Kornell, 2013). Judgments made a short time after study, from the cue alone, are far more accurate (Nelson & Dunlosky, 1991). | Strong | Progress shows recall measured at review time, never "pages read" as learning. Confidence is asked when the answer is absent. The calibration line shows how often Sure was right. |
| **Highlighting** | Highlighting and rereading rated "low utility" (Dunlosky et al., 2013). | Strong | **Save idea** makes a recall card, not a highlight. |
| **Dual coding** | Words and images are held in separate but linked systems, and using both can help (Clark & Paivio, 1991). But "imagery use for text learning" rated low utility (Dunlosky et al., 2013). | Weak for this product | Keep the source's figures in the reader and show them on cards that came from them. Don't build drawing or image-generation tools. |
| **Modern schedulers (FSRS vs SM-2)** | FSRS comes from a memory model trained on 220 million review logs; the scheduler cut review cost against earlier methods (Ye, Su & Cao, 2022; Su et al., 2023). The open `srs-benchmark` (by the FSRS authors, on about 10,000 to 20,000 Anki users' histories, depending on version) reports FSRS predicting recall better than SM-2 on log loss, AUC and RMSE. Anki ships FSRS as an option since 23.10. | Moderate | Use FSRS after the fixed steps. Caveats: the benchmark measures prediction, not learning outcomes, and it uses Anki data where the same card repeats. Our questions vary per review, so we check FSRS's predictions against our own data (see [section 8](#8-metrics-that-show-the-learning-works)). |
| **Deliberate practice (*Peak*)** | Expert performance follows long, effortful, feedback-rich practice aimed at weaknesses (Ericsson, Krampe & Tesch-Römer, 1993; Ericsson & Pool, 2016). A meta-analysis found deliberate practice explained 26% of the variance in games, 21% in music, 18% in sports, 4% in education and under 1% in professions (Macnamara, Hambrick & Oswald, 2014). Ericsson disputed the definition they used. | Mixed | Skills are a light log built on *Peak*'s loop (goal, focus, feedback, next fix). We don't promise outcomes. |

---

## 3. The loop

```
Add a reading ─► Read a section ─(30 s in it)─► key ideas + questions written in the background
                     │
                     ▼  end of section: "Recall this section" (1 click)
               Brain dump (free recall, text hidden)
                     ▼
               Questions, missed ideas first ─► results at the end: recall map + answers
                     ▼
               One card per key idea starts its schedule: 1 day, 2 days, 3 days, then FSRS
                     ▼
Home / Mind: "Review 14" (1 click) ─► one question per due card ─► result after each answer
                     ▲
Lessons (+ Log), saved ideas (select → Save idea), words: also cards, same queue
```

Without an AI key, every step still runs. The learner checks their own dump and written answers against a checklist, and the sample reading has everything pre-written.

---

## 4. Core data model

All new member tables get `user_id` and the base frame's `ownRows` row-level security policy (`apps/server/src/db/schema.ts`). The old Peak tables had no `user_id` on `sections` and `ideas`; here every table has one, so RLS covers all of them. Ids are client-chosen UUIDs wherever the client creates the row, following `entries.create` and `review.add`.

### 4.1 Shape

```
readings 1─* sections 1─* cards (kind 'idea', origin 'ai' | 'member')
                               1─* questions
cards 1─* review_log (each answer; points at the question asked, if any)
entries (lesson) 1─1 cards (kind 'lesson')        entries (reading.finished, practice): milestones and logs
recall_attempts *─* cards (results: one status per idea)
teach_sessions *─1 cards       skills 1─* entries (practice)       ai_calls (usage)    preferences (1 per member)
```

### 4.2 Changes to existing tables

**`cards`** (one per thing to remember):

| Column | Type | Note |
| --- | --- | --- |
| `kind` | text | Widen to `'idea' \| 'lesson' \| 'word'`. |
| `reading_id` | uuid null → `readings` (cascade) | For ideas and words met while reading. |
| `section_id` | uuid null → `sections` (cascade) | |
| `position` | int null | Order of key ideas in a section. |
| `origin` | text not null default `'member'` | `'ai'` for key ideas the AI wrote, `'member'` for saved ideas, lessons and words. |
| `quote` | text null | The exact sentence of the source the idea rests on. Used as the hallucination guard and shown with the answer. |
| `details` | jsonb null | Words: `{ word, form, sentence, meaning }`. |
| `level` | smallint not null default 0 | Index into `QUESTION_LEVELS`; rises on a right answer, falls on a miss. |
| `started_at` | timestamptz null | Null until the card is first recalled. Only started cards are in the queue. Backfilled to `created_at` for existing rows. |
| `deleted_at` | timestamptz null | Set when its reading or lesson entry is removed; cleared on restore; purged by `cleanup` after 30 days. |
| `state` | jsonb | New shape `SchedulerState` (see [5](#5-scheduler-decision)); old rows rebuilt by replay. |

`prompt` is the **cue** (a question that doesn't give the idea away). `answer` is the idea itself. So every card can be reviewed as a plain recall card even when it has no questions. Add index `(section_id, position)`.

**`review_log`** (every answer):

| Column | Type | Note |
| --- | --- | --- |
| `answer_id` | uuid unique | Client-chosen, so a double tap or retry counts once. This works for new cards too, which have no due date to check. |
| `question_id` | uuid null → `questions` (set null) | Null for cue recall and self-rated cards. |
| `ask` | text not null default `'self'` | `'question' \| 'cue' \| 'self'`. |
| `mode` | text not null default `'review'` | `'recall'` (right after reading), `'review'`, `'practice'` (retry round: logged, schedule unchanged). |
| `correct` | boolean null | |
| `response` | jsonb null | What the learner wrote or picked, including the typed guess. |
| `confidence` | text null | `'guessing' \| 'think_so' \| 'sure'`. |
| `feedback` | text null | The judge's feedback. |
| `graded_by` | text not null default `'self'` | `'code' \| 'ai' \| 'self'`. |
| `overridden_at` | timestamptz null | Set when the learner tapped **Count it as right**. |
| `predicted_recall` | real null | The scheduler's predicted chance of recall at the moment of answering. |
| `scheduler` | text not null default `'steps-ease-v1'` | Which scheduler made the decision. |

### 4.3 New tables

| Table | Columns (besides `id`, `user_id`, `created_at`) | Note |
| --- | --- | --- |
| `readings` | `title`, `author` null, `source` (`'paste' \| 'url' \| 'pdf_upload' \| 'pdf_url' \| 'epub' \| 'web_capture'`), `source_url` null, `requested_url` null, `status` (`'importing' \| 'ready' \| 'failed'`), `error` null, `word_count`, `position` jsonb null (`{ sectionId, block }`), `last_opened_at` null, `goal_by` date null, `finished_at` null, `finished_entry_id` null → `entries`, `deleted_at` null | Index `(user_id, last_opened_at desc)`. Unique `(user_id, requested_url)` where not null, so the same link finds the same reading. |
| `sections` | `reading_id` (cascade), `position`, `level` (1 to 3), `title`, `blocks` jsonb (`Block[]`), `word_count`, `first_seen_at` null, `read_at` null, `recalled_at` null, `write_status` (`'none' \| 'queued' \| 'writing' \| 'ready' \| 'failed' \| 'needs_key' \| 'paused'`), `write_error` null, `prompt_version` null | `write_status` replaces the old item-wide `content_items.status`, so one failed chapter doesn't block a book. |
| `questions` | `card_id` (cascade), `reading_id`, `section_id`, `type`, `level`, `content` jsonb, `prompt_version`, `retired_at` null, `report` text null | Index `(card_id)`. Retired questions are never asked again, and old answers keep pointing at them. |
| `recall_attempts` | `reading_id`, `section_ids` uuid[], `text`, `status` (`'waiting' \| 'grading' \| 'graded' \| 'self' \| 'failed'`), `results` jsonb null (`{ cardId, status: 'covered' \| 'vague' \| 'missing' }[]`), `feedback` null, `graded_by` | `'waiting'` means the key ideas aren't written yet. |
| `teach_sessions` | `card_id` (cascade), `idea` text (copy at start), `messages` jsonb, `result` jsonb null, `updated_at` | Old `notes` (kind `feynman`), moved to its own table. |
| `skills` | `name`, `goal` text null, `weekly_minutes` int null, `archived_at` null | |
| `media` | `reading_id` (cascade), `content_type`, `bytes`, `width`, `height`, `data` bytea | Images in Postgres for now: backups include them and there is nothing else to run. Move to object storage when hosting is decided. |
| `reading_time` | `reading_id`, `day` date, `seconds` | Primary key `(user_id, reading_id, day)`; upserted by heartbeats. |
| `ai_calls` | bigint id, `purpose`, `model`, `input_tokens`, `output_tokens`, `ok`, `error` null, `ms`, `at` | One row per provider call. Powers the usage page, the budget and question-quality metrics. |
| `preferences` | `user_id` primary key, `timezone` default `'UTC'`, `question_amount` (`'quick' \| 'standard' \| 'thorough'`) default `'standard'`, `question_style` (`'mixed' \| 'written' \| 'choice'`) default `'mixed'`, `quality_check` default true, `guess_first` default true, `desired_retention` real default 0.9, `ai_monthly_budget_usd` numeric default 5, `review_batch` int default 20 | A new table, not columns on `users`: `users` has no RLS by design ("Only the auth module touches them"). |

### 4.4 Entry types (`packages/domain/src/entries.ts`)

| Type | Pillar | Jobs | Details | Note |
| --- | --- | --- | --- | --- |
| `lesson` (exists) | mind | remember | `{ cue?: string }` (new, optional) | Creating one now also creates its card ([7.10](#710-life-lessons-in-the-same-queue)). |
| `reading.finished` (new) | mind | relive, track | `{ readingId, title, author? }` | Text holds the key lessons. Not shown in the + Log type picker; made by **Finished**. Path can turn it into a milestone later without a schema change. |
| `practice` (new) | mind | track | `{ skillId, skill, minutes, focus?, next? }` | Logged from + Log or the Skills card. |

---

## 5. Scheduler decision

### 5.1 Options

| Option | For | Against |
| --- | --- | --- |
| Keep steps-then-ease (`stepsThenEase` in `packages/domain/src/scheduler.ts`) | Built and tested; easy to explain. | Ease rules are hand-set. Ease drops ("ease hell"). No prediction of recall, so no honest "fading" view and no retention target. |
| Pure FSRS | Best published recall prediction; a retention target the member can understand. | Its own early intervals replace the 1-2-3 days the owner asked for. |
| **Hybrid (chosen): steps 1, 2, 3 days, then FSRS** | Keeps the owner's steps (and the successive-relearning shape). FSRS updates its memory state on every answer, including the steps, so it is well informed at graduation. Gives recall predictions for Progress. | Two rule sets to test. FSRS is tuned on repeated identical cards; ours vary the question. |

### 5.2 Rules (`stepsThenFsrs` in `packages/domain/src/scheduler.ts`, behind the existing `Scheduler` type)

- **New card:** first answered in the recall check, or at once when added by hand (lesson, saved idea, word).
- **Steps:** "Got it" on a step moves to the next: 1 day, then 2 days, then 3 days. "Hard" repeats the current step. "Forgot" goes back to step 1, and the card comes back in 10 minutes. Same as today.
- **Graduation:** after the 3-day step, the next gap comes from FSRS at the member's target (default 90%), capped at 365 days.
- **Lapse after graduation:** comes back in 10 minutes, then 1 day, then FSRS again. **Change from today**, where a lapse restarts all three steps. FSRS has already cut the card's stability, so three more fixed reviews would be wasted work. Flagged for the owner in [13](#13-changes-to-earlier-decisions).
- **Ratings:** the UI shows three self-rating buttons, **Forgot / Hard / Got it** (`again / hard / good`). `easy` is still accepted by the contract and comes only from grading (a written answer that makes every point, given with Sure or no confidence). FSRS works with a subset of ratings.
- **Several answers on one card in one sitting** (e.g. two questions on the same idea after reading): the first answer sets the schedule; a later wrong answer still counts; a later right one changes nothing. Ported from the old `reviewIdea`.
- **Answering early** (a card not yet due): refused with `CONFLICT`, as in `review.answer` today, except in `recall` mode on a card that hasn't started.
- **Retry round** (`mode: 'practice'`): logged, schedule unchanged.
- **Teach-back with gaps:** sets `due_at = min(due_at, now + 10 min)` without changing memory state ([7.12](#712-teach-back)).

Library: `ts-fsrs` v6 (MIT; needs Node ≥ 24, and the repo uses Node 26). It exposes `desiredRetention`, `maximumInterval`, learning-step options, `enableFuzz` and a `forgettingCurve` for predicted recall. Our wrapper owns the 1-2-3 day steps, so we don't depend on how the library handles day-length steps. Pin the FSRS model version as a constant and write it into `review_log.scheduler` (e.g. `steps-fsrs-v1`). Fuzz on for graduated cards, so ideas added together don't come back together forever.

`SchedulerState` (jsonb in `cards.state`): `{ step: 0 | 1 | 2 | null, reps, lapses, memory: <ts-fsrs card memory fields> | null, lastReviewAt }`. Add `retrievability(state, now)` to the `Scheduler` type for Progress and for `predicted_recall`.

### 5.3 Per-idea scheduling

The card is the idea. Each review asks one thing about it, picked in this order:

1. A question on the card that hasn't been asked yet, nearest the card's level, lower levels first after a miss (`pickQuestion`, ported from old `packages/core/src/ideas.ts`).
2. Otherwise the cue itself, as a written recall: judged against the idea (`mustHave: [answer]`) when there is a key, self-rated when not.

A background top-up writes a new question for cards whose questions have all been asked ([7.3](#73-key-ideas-and-questions-when-they-get-written-old-task-1)). The old mastery rule (3 correct days, then monthly) goes: FSRS replaces it, and "known" becomes a reading of predicted recall ([7.16](#716-progress-view)).

### 5.4 Migrating existing data

The base frame has `cards.state` in the steps-ease shape and `review_log (card_id, rating, reviewed_at, next_due_at)`.

1. Migration adds the new columns with defaults. Existing log rows get `scheduler = 'steps-ease-v1'`, `ask = 'self'`, `mode = 'review'`.
2. `pnpm db:replay-schedules` (`apps/server/src/cli/replay-schedules.ts`, owner account) replays each card's log in `reviewed_at` order through `stepsThenFsrs`. It writes the new `state` and `due_at` and sets `started_at` where null. Deterministic, so it is safe to run twice. Cards with no log get `initial()`.
3. Log rows are never rewritten. A unit test replays the e2e sequence (good, good, good, good) and checks the steps give 1, 2 and 3 days and the 4th gap comes from FSRS.

**Acceptance:** after the replay on a copy of the database, every started card has a non-null `memory` once graduated, `due_at` equals the replay result, and `review.due` totals change only for graduated cards.

### 5.5 Settings

Settings → Review: "When an idea comes back, aim to remember it": 80%, 85%, **90%**, 95% (`desired_retention`). The line under it: "Higher means more reviews." Personal tuning of FSRS parameters from the member's own log (`@open-spaced-repetition/binding`) waits until a member has about 1,000 reviews (Release 9).

---

## 6. How AI is used, and where it is not trusted

### 6.1 What AI does, and what checks it

| Job | Prompt (in `packages/llm/src/`) | Reused from | Checked by |
| --- | --- | --- | --- |
| Write a section's key ideas, cues and questions | `writeSection` (`questions-v9`) | `generate.ts` `RULES`, `writeQuestions`, `planBatches` | Schema parse per type (`parseQuestionContent`); `lintQuestion` rules in code (no copied runs over 8 words, no "define/what is", no given-away must-have points); each idea's `quote` must be in the section (normalised substring, like `parseTerms`); MCQ and steps shuffled in code; one rewrite round for rejects. |
| Second-pass check of questions | `checkQuestions` | `CHECK_RULES`, `qualityCheck` | It works out worked-problem answers and traces predict-output code itself; a disagreement sends the question back. If the check fails, questions that passed the code rules are kept. Default on. |
| Grade a brain dump | `gradeRecall` | `recall.ts` `GRADE_SYSTEM` | One verdict per idea; an unreadable verdict counts as **missing**. |
| Grade a written answer | `judgeAnswer` | `judge.ts` | The judge only marks points covered, vague or missing; the score is computed in code (`scoreRubric`); a stated misconception caps it at 1; quotes that aren't in the answer are dropped. |
| Write a cue for a lesson or saved idea | `writeCue` (new) | — | Cue must not contain 3 or more of the idea's content words (`lintQuestion`'s give-away rule), and is at most 120 characters. |
| Write top-up review questions | `writeForCards` (`review-v4`) | `writeForIdeas` | Same code checks. |
| Define a word | `defineWord` | `words.ts` | The learner's sentence is kept as is; a written example must contain the word. |
| Suggest words in a section | part of `writeSection` | `parseTerms` | Sentence must be in the section and contain the word. |
| Teach-back student | `teachTurn` | `tutor.ts` `TEACH_SYSTEM` | At most 3 follow-ups, then a summary; gaps are stated against the source. |
| Explain a passage (Release 5) | `explainPassage` | `tutor.ts` | Its quote is shown only if it is really in the section. |

Each prompt begins with a fixed `Task: <name>` line. `e2e/fake-llm.ts` grows from model lists only to also answering `/v1/messages` and `/v1/chat/completions`, routed by that line, with canned JSON, so e2e tests never call a provider.

### 6.2 Where AI is not trusted

- **Scheduling:** never. Code turns grades into ratings and ratings into dates.
- **Choice, number, order and output questions:** graded in code (`questionTypes` registry). No AI call.
- **Written answers:** the AI marks points; code sets the score. The learner sees which points were missed and can tap **Count it as right** once per answer. That is logged (`overridden_at`), and Progress shows how often it was used.
- **Facts:** every key idea carries a `quote` from the source, shown with the answer as "From the text: …". An idea without a quote in the text is dropped. Explanations that go beyond the text must say so.
- **Source text as instructions:** web pages are untrusted. Sections go inside `<section>` tags, and every system prompt says text inside them is material, never instructions. Replies are parsed against a schema, and nothing from a model is rendered as HTML.
- **Bad questions:** every question has **Report a problem** (wrong answer key, unclear, not in the text). One report retires it and logs the reason in `questions.report`.
- **Judge down or slow (over 20 s):** the answer is kept. The learner sees the model answer and the checklist and marks it themselves (Right / Partly / Wrong → `good / hard / again`, `graded_by = 'self'`).
- **Language:** prompts say "write in the language of the text", so a German book gets German questions.

### 6.3 Cost control with the member's own key

- **Model:** the low-cost model already picked at `ai.saveKey` (Haiku or a mini model, `suggestModel` in `packages/llm/src/providers.ts`).
- **Usage:** change `LlmProvider.complete` to return `{ text, usage: { inputTokens, outputTokens } }` (Anthropic `usage.input_tokens/output_tokens`; OpenAI `usage.prompt_tokens/completion_tokens`). One `ai_calls` row per call goes through one helper, `callAi(userId, purpose, req)` in `apps/server/src/learning/ai.ts` (ported from old `apps/api/src/judge.ts` `userAi`).
- **Price:** a small hand-kept price table per model family in `packages/llm/src/prices.ts`. For an unknown model, show tokens only, with no money estimate.
- **Spend only on read sections:** writing starts after 30 seconds in a section, or on **Recall**.
- **Batching:** whole chapters per call while the reply stays under budget (`planBatches`, reused). One quality-check call per batch.
- **Judge only when needed:** choice, number, order and output answers cost nothing.
- **Top-ups:** at most one new question per card per 7 days, at most 8 cards per call, only for cards due in the next 2 days.
- **Budget:** when this month's estimated spend reaches `ai_monthly_budget_usd`, background jobs set `write_status = 'paused'` and Mind shows one line: "Paused writing questions: this month's AI budget is used. Change it in Settings." Grading still runs, because it is small and the learner is waiting. **Recall** still writes ideas for the section it was pressed on.
- **Retries:** at most 2 per job, with backoff (pg-boss `retryLimit: 2, retryBackoff: true`), as in the old `jobs.ts`.

### 6.4 Day 0 without a key

| What | Without a key | With a key |
| --- | --- | --- |
| Sample reading "How to remember what you read" (about 1,200 words, 3 sections, about this app's own method) | Added to every new member on first visit to Mind. Ideas, cues and questions are pre-written in `apps/server/src/seed/sample-reading.ts`, with ids derived from the member id so it is added once. | Same. |
| Own readings | Import, read, brain dump. After the dump: **Compare with the text** shows the section beside the dump. Ideas come from **Save idea**. | Ideas and questions written for them. |
| Brain dump check | The learner ticks each key idea: Got it / Partly / Missed (sample reading, or ideas they saved). | AI marks each idea. |
| Written answers | Self-check against the model answer and its checklist. | AI judge. |
| Lessons, saved ideas | Cards with the member's cue, or a fallback cue ([7.9](#79-saved-ideas-and-mental-model-cards)). | AI writes a cue if none is given. |
| Hint | One line on Mind: "Add your own AI key in Settings to get questions on your readings." | — |

When a key is added, sections with `write_status = 'needs_key'` are queued again (old `requeueWaitingItems`).

---

## 7. Features

Click counts follow the vision: typing a value doesn't count.

### 7.1 Adding readings

**Problem:** getting text into the app must be faster than deciding not to bother.

**Evidence:** none specific; it is the entry to everything else.

**Behaviour**

| Operation | Clicks | How |
| --- | --- | --- |
| Add a link | 1 | Paste into the **Add a reading** box on Mind (or + Log → Reading), then **Add**. |
| Add pasted text | 1 | Paste text or Markdown, then **Add**. The title comes from the first heading, or the first words. |
| Add a PDF or EPUB | 1 | Drop the file on Mind, or **Add** → pick a file. |

The new reading shows at once in Reading now as "Importing…" (optimistic, client-chosen id), then opens to section 1 when ready. Adding the same link again opens the existing reading.

**Defaults:** title and author from the page, PDF or EPUB metadata, editable from the reading's menu.

**Data:** `readings`, `sections`, `media`.

**API** (`packages/contract/src/index.ts`, new `readings` namespace):

- `readings.add({ id, url? | text?, title? })` → `Reading`
- `readings.addFile({ id, file })` (oRPC `File` input, 50 MB limit) → `Reading`
- `readings.list({ status?: 'reading' | 'finished' | 'all' })` → `Reading[]` with progress (`sectionsRead / sections`)
- `readings.remove({ id })` / `readings.restore({ id })`: Undo, as with entries; purged after 30 days

**Jobs:** `import-reading` (stately per reading). Fetch with the old SSRF-safe fetcher (`apps/api/src/web/fetch.ts`): public addresses only, checked on every redirect and at connect, with size and time limits. Readability extraction (`web/extract.ts`) → `htmlToBlocks` (`packages/core/src/html.ts`) → `splitSections` (`content.ts`), changed to the section rules in [#1](https://github.com/rohitchoudharii/life-log/issues/1): the author's headings are the boundaries, and a section past about 2,500 words is cut at a block. Books follow [#2](https://github.com/rohitchoudharii/life-log/issues/2) inside each chapter. PDF via pdf.js (`books/pdf.ts`: headings by size, two columns in order, repeated headers dropped, `page` blocks). EPUB (`books/epub.ts`: chapters from the table of contents, zip-bomb limits, DRM refused). Images are downloaded, checked, re-encoded and stored in `media`; SVG refused (old `media.ts`). arXiv links use the HTML version (old `web.ts`).

**AI:** only for an article of 1,000 words or more with no headings ([#1](https://github.com/rohitchoudharii/life-log/issues/1)). The AI returns where headings go and their titles; code inserts them, so the article text never changes. Without an AI key, or with an invalid reply, the article stays as one section.

**Edge cases**

- A page behind a sign-in wall: detected as in the old `web.ts`, and fails with "This page needs you to be signed in. The Chrome extension will capture it later."
- A scanned PDF (almost no text): refused with "This PDF is a scan; Life Log Club can't read scans yet." OCR comes later ([#4](https://github.com/rohitchoudharii/life-log/issues/4)).
- A DRM-protected EPUB: refused.
- More than 2,000 sections: refused.
- A section with no words (a chapter heading): kept as a parent, never offered for recall.
- Image download fails: the image is dropped and its alt text kept.
- A server restart mid-import: the job is retried; stuck `importing` readings are queued again on start.

**Later:** the Chrome extension posts `web_capture` HTML to `readings.capture`, the same pipeline. Public web books with one page per chapter ([#3](https://github.com/rohitchoudharii/life-log/issues/3)) and books the member makes from captured articles ([#5](https://github.com/rohitchoudharii/life-log/issues/5)) build on it. Voice is not used here.

**Acceptance**

- e2e `mind-add.spec.ts`: pasting a link served by the e2e server makes a reading appear at once, then show its sections.
- Pasting the same link twice gives one reading.
- A private address (`http://127.0.0.1`, or a redirect to it) fails with a clear message.
- The PDF and EPUB unit tests from `apps/api/src/books/books.test.ts` pass in `apps/server`.
- Ported `html.test.ts`, `extract.test.ts` and `fetch.test.ts` pass.
- Member B can't read member A's reading, by id or by `readings.list`.

### 7.2 Reader and sections

**Problem:** reading on screen should feel like a quiet book, and recall must sit right where the reading ends.

**Evidence:** retrieval right after study, without the text, is the strongest step we have (Roediger & Karpicke, 2006; Karpicke & Blunt, 2011).

**Behaviour:** route `/mind/read/$readingId`.

- Cream paper, serif type, about 65 characters a line.
- A contents list on the left (a drawer on narrow screens). Each section has a dot: unread, read, recalled.
- **Continue a reading:** 1 click on the book. It opens at `readings.position` (section and block).
- Position is saved 2 seconds after scrolling stops (`readings.savePosition`).
- At the end of every section with words: an index card **Recall this section** (1 click), or **Recall chapter** when the section is the last child of a chapter. The `R` key does the same.
- Selecting text shows a small bar: **Save idea**, **Add word** (Release 6), **Explain** (Release 5).
- Keys: `J` and `K` for the next and previous section, `R` to recall, `Esc` to close the bar.

**Defaults:** a section counts as **seen** after 30 seconds on screen with activity (scroll, key or pointer in the last 60 seconds). That queues its writing. It counts as **read** when its end has been on screen.

**Data:** `sections.first_seen_at`, `sections.read_at`, `readings.position`, `readings.last_opened_at`, `reading_time`.

**API**

- `readings.get({ id })` → reading, contents (section ids, titles, levels, word counts, statuses), position
- `readings.section({ id })` → blocks, key-idea count, `write_status`
- `readings.savePosition({ id, sectionId, block })`
- `readings.seen({ sectionId, seconds })`: a heartbeat every 30 s while reading. Sets `first_seen_at`, adds to `reading_time`, and queues writing on the first call.
- `readings.update({ id, title?, author?, goalBy? })`

**Jobs:** `write-section` is queued by `readings.seen` ([7.3](#73-key-ideas-and-questions-when-they-get-written-old-task-1)).

**Edge cases**

- Fast scrolling through a book doesn't queue writing; it needs 30 seconds in one section.
- Two tabs open: the last saved position wins.
- Code blocks render monospaced and wrapped.
- Links in text open in a new tab. Importing linked pages as child readings is later.

**Acceptance**

- e2e: opening a reading, scrolling to section 3, reloading, opens section 3.
- The Recall card appears after the last block of a section.
- Thirty fake-timer seconds in a section set `first_seen_at` and queue exactly one `write-section` job.

### 7.3 Key ideas and questions: when they get written (old task 1)

**Problem (from old task 1):** questions were written only from Manage test, three taps deep. Nothing said when they were ready, and a new user couldn't try the loop.

**Evidence:** the brain dump needs only key ideas, not questions. Free recall is the strongest step, so it can start before questions exist. Item-specific pretesting benefits (Pan & Carpenter, 2023) don't justify writing questions for sections nobody reads.

**Decision: option 4, changed.**

1. **Seen → write.** After 30 seconds in a section, `write-section` writes, in one call per chapter batch:
   - the section's key ideas (1 to 20, one sentence each, each with a **cue** and a **quote**; see **How many key ideas** below)
   - questions at the member's amount
   - in Release 6, up to 3 suggested words

   A section takes from about 2 to 10 minutes to read (sections are cut past about 2,500 words, [#1](https://github.com/rohitchoudharii/life-log/issues/1)), which covers the writing time.
2. **Recall → write now.** If the learner presses **Recall** first, the job is queued at high priority and the brain dump opens at once. The dump takes minutes, which covers the wait. When the dump is submitted:
   - Ideas ready: it is graded.
   - Not ready: the screen shows "Checking against the text…" and polls every 2 seconds.
   - Questions not ready when grading finishes: "Your questions are almost ready" for up to 60 seconds, then the session goes on with cue recall for each idea.
3. **No Manage test.** Settings → Questions holds **How many** (Quick / **Standard** / Thorough), **Kinds** (Mixed / Written / Choice) and **Check questions twice** (on). Each section's menu has **Rewrite questions** for that section.
4. **On import:** nothing is written.

**Amounts (questions per key idea, at recall time)**

| Amount | Questions | Note |
| --- | --- | --- |
| Quick | 0: only the brain dump and cue recall | Cheapest. Every idea is still reviewed through its cue. |
| **Standard** (default) | 1 per idea, at explain or apply | Recall is asked through the cue. |
| Thorough | 2 per idea: one at explain, one at apply | |

**How many key ideas**

- **Every real idea in the section becomes a key idea.** An idea that is not a card never comes back in review, so losing one now means forgetting it later.
- The prompt gives a guide of about one idea per 150 words, so the model knows the expected density. The guide is not a limit: a dense section gets more ideas, and a story or example section can get only one. The prompt says not to pad to reach the guide.
- **Hard limit: 20 per section.** Sections are cut past about 2,500 words ([7.1](#71-adding-readings)), so 20 is about one idea per 125 words in the longest section and should not be reached in practice. If the model still returns more than 20, the job keeps the 20 most important (the model ranks them) and the rest show on the recall results under **More ideas in this section**, each with **Add** (1 click). Nothing is dropped silently.
- Every idea still needs a quote found in the section; an idea without one is not stored.
- The member can always add an idea later: **Add an idea** on the results, or select text and **Save idea**.

This replaces the old per-word rule (`questionCountFor`) with a per-idea rule, because ideas are what get scheduled. The automatic default is **Standard**, not Quick. Quick would mean every review is a cue recall, which costs more judge calls later and gives less varied retrieval.

**Rewrite questions:** retires the section's questions (`retired_at`), keeps every `review_log` row, and writes new ones for the same cards. Key ideas with `started_at` are never replaced. If the section has no started cards, **Rewrite key ideas** is also offered. Started ideas can be edited (`review.update`) or added to (**Add an idea** on the recall results). No replace-all.

**The ideas race (from old task 1), resolved**

- `write-section` locks the section row (`select … for update`) and inserts key ideas only when the section has no `origin = 'ai'` cards.
- The brain dump never writes ideas itself. It waits for `write_status = 'ready'`.
- Recall results point at card ids, and no job deletes cards. Only the member does, by removing a reading or a lesson.

**Top-ups for review:** the `top-up-questions` job runs every 6 hours and after each Review session. It finds started cards due in the next 2 days that have no unasked question and no new question in the last 7 days, and writes one each. It is skipped when the budget is reached or there is no key.

**Cost shown:** Settings → AI: "This month: 46 calls · 210k tokens · about $0.31 of $5". Each reading's menu shows "Questions so far: about $0.04".

**Data:** `sections.write_status`, `cards` (ideas), `questions`, `ai_calls`.

**API**

- `questions.rewrite({ sectionId })`
- `questions.report({ id, reason })`
- `readings.section` returns `write_status`

**Jobs:** `write-section` (stately per reading, so a reading's batches never overlap; `localConcurrency: 3`; heartbeats; one-hour expiry, as in the old `jobs.ts`), `top-up-questions`.

**Edge cases**

- No key: `write_status = 'needs_key'`, and Recall goes down the self-check path.
- Key removed mid-job: the job ends with `needs_key`.
- Provider error after retries: `failed`, with **Try again** on the section.
- The model returns 0 valid ideas: retried once, then `failed`.
- Very short sections (under 80 words): merged with the next section for writing; ideas belong to the section they quote.

**Acceptance**

- e2e with the fake LLM: being in a section for 30 seconds leads, after the job runs, to `write_status = 'ready'`, 2 or more `origin='ai'` cards each with a quote found in the section, and one active question per card.
- Pressing Recall on an unwritten section opens the dump at once, and submitting it shows the waiting line until the job finishes.
- `questions.rewrite` keeps all `review_log` rows and the `started_at` of every card.
- A fake-LLM idea whose quote isn't in the text is not stored.
- When the budget is reached, a new section stays `paused` and the Mind banner shows.

### 7.4 Recall check: brain dump, then questions

**Problem:** reading feels like learning; recall shows what actually stuck.

**Evidence:** free recall after reading, then feedback (Roediger & Karpicke, 2006; Karpicke & Blunt, 2011). Generation (Bertsch et al., 2007). Feedback reduces wrong learning (Butler & Roediger, 2008). Delayed feedback within a set has some lab support (Butler, Karpicke & Roediger, 2007).

**Behaviour:** route `/mind/recall/$attemptId`.

1. **Recall this section** (1 click). The text hides. One large box: "Write everything you remember. Lists and fragments are fine." The section title shows; nothing else.
2. **Done** (typing doesn't count). Or **Nothing comes to mind**, which records an empty dump with every idea missed. This is an honest result and still helps learning (Kornell, Hays & Bjork, 2009).
3. Questions, one per key idea at the level its dump mark sets (see **Deeper questions for covered ideas** below), ordered: ideas the dump missed, then vague ones, then the rest. Written questions come before choice questions, and topics are shuffled within each group (`orderForTest`, reused). Each answer is submitted with the confidence buttons ([7.8](#78-confidence-and-guess-first-old-task-2)); no result shows yet.
4. **Results**:
   - the recall map: every key idea marked covered, vague or missed, with its quote
   - "You were sure about these" (Sure but wrong) first
   - each answer with its verdict and the model answer
   - when each idea comes back ("Back tomorrow")
   - **Retry missed ideas** asks a new question or the cue for each missed idea in `practice` mode
   - **Teach one back** on a missed or vague idea (Release 7)
   - **Done** returns to the reader, at the next section
5. Recall per section is the default. **Recall chapter** covers all of a chapter's sections. The dump is graded against every key idea in the chapter, and the session asks at most 10 questions, picked missed-first. Ideas without a question start from their dump mark (below), so no idea is left out of review.

Total: **1 click to start**, then about 1 click per question.

**How cards start:** each key idea's first rating comes from its first question answer in the session. If it had no question, the dump status decides: covered → `good`, vague → `hard`, missed → `again`. `started_at = now`. So a covered idea is back in 1 day; a missed one in 10 minutes.

**Deeper questions for covered ideas**

A question that asks for the same fact the dump already gave adds little. A covered idea gets a harder, different retrieval instead: a "why" or a "how", not a repeat (desirable difficulties, Bjork, 1994). A missed idea gets the simplest question, because a hard question on an idea that is not there yet is a difficulty the learner can't meet.

| Dump mark | Start level | What is asked |
| --- | --- | --- |
| Missed | recall | The idea's cue, as a written recall |
| Vague | explain | The idea's lowest question above recall |
| Covered | explain or apply | The idea's highest question |

- Questions are written before the dump ([7.3](#73-key-ideas-and-questions-when-they-get-written-taskmd-item-1)), so the dump result can't shape them. Instead, `write-section` writes every stored question **above recall** (explain or apply at Standard; Thorough writes one at each), and the recall level is always the cue. So the rule needs no AI call after the dump and adds no wait.
- A missed idea's written question stays unasked and is used in a later Review, once its level has risen.
- The start level is stored in `cards.level` when the card starts. From then on the existing rule applies: a right answer moves the idea up a level, a miss moves it down, and each Review asks a new question at the idea's level, up to analyse and transfer.
- With Quick there are no stored questions, so every idea is asked through its cue.
- Without a key, the same rule applies to the sample reading's pre-written questions.

Example, a section on sleep and learning with four key ideas. The dump covers A and B, is vague on D and misses C.

| # | Idea | Mark | Level | Question |
| --- | --- | --- | --- | --- |
| 1 | C. A tired brain learns new information poorly. | Missed | recall | "What does the text say about studying when you are tired?" (the cue) |
| 2 | D. Study, sleep, then a short review the next morning. | Vague | explain | "Why does the text suggest a short review the morning after you study?" |
| 3 | A. During deep sleep, the brain moves new memories into long-term storage. | Covered | explain | "Why does one night of sleep often improve recall the next day, with no extra practice?" |
| 4 | B. Missing sleep after study means the memories are not stored well. | Covered | apply | "Your exam is tomorrow at 9:00. It is 22:00 now, and you have 4 hours of study left. What do you do, and why?" |

**Without a key:** after **Done**, **Compare with the text** shows the dump beside the section. If the section has key ideas (sample reading, or ideas the member saved), each gets Got it / Partly / Missed, one click each and defaulting to Missed, which feeds the same rules. With no key ideas, the screen offers **Save idea** on the text.

**Data:** `recall_attempts`, `cards.started_at`, `review_log` (`mode = 'recall'`), `sections.recalled_at`.

**API**

- `recall.submit({ id, readingId, sectionIds, text })` → attempt
- `recall.get({ id })` → status, ideas with statuses (only once the session ends), and the ordered items to ask (card id, plus question or cue)
- `recall.selfMark({ id, marks: { cardId, status }[] })` → for the no-key path
- answers go through `review.answer` with `mode: 'recall'` ([7.7](#77-review-queue-and-feedback-old-task-3))

**Jobs:** `grade-recall`, queued by `recall.submit`, or when `write-section` finishes for a waiting attempt.

**AI:** `gradeRecall`, one call. Feedback is 1 to 3 sentences, shown only on the results screen.

**Edge cases**

- The dump is over 20,000 characters: refused with "That's longer than a brain dump needs."
- The learner leaves mid-session: answers already sent are kept and the attempt can be reopened from the section menu.
- Grading fails after retries: `failed`, and the learner can self-mark or **Try again**.
- A section with no key ideas and no key: only Compare with the text.

**Voice later:** `recall.submit` takes `source: 'typed' | 'voice'` from day 1. A phone or browser transcription fills `text`.

**Acceptance**

- e2e (fake LLM): read a section → Recall → type a dump → Done → questions appear with ideas the dump missed asked first → answer all → results list each idea with covered/vague/missed → every key idea has `started_at`, and covered ones are due in 1 day (± a minute).
- No result shows before the last answer.
- With the fake LLM marking one idea covered and one missed: the covered idea is asked a stored question above recall, the missed idea is asked its cue, and each card's `level` after the session is its start level moved by its answer.
- Nothing comes to mind marks all missed.
- No-key path: the sample reading's dump can be self-marked, and the cards start.

### 7.5 Question types

**Problem:** recall-only questions test memory of the page, not understanding.

**Evidence:** retrieval with inference questions (Karpicke & Blunt, 2011). Self-explanation and elaboration ("why", "how") (Chi et al., 1994; Dunlosky et al., 2013). Desirable difficulty with a ceiling (Bjork & Bjork, 2011).

**Types** (registry ported from old `packages/core/src/questions.ts` to `packages/domain/src/questions.ts`, unchanged in shape):

| Type | Graded by | Release |
| --- | --- | --- |
| `short_answer` | AI judge on must-have points | 1 |
| cue recall (not a stored type; built from the card) | AI judge on the idea, or self | 1 |
| `mcq` (4 options, `whyWrong` per option, shuffled in code) | code | 4, with Guess first |
| `worked_problem` (number within tolerance; working judged) | code + judge | 5 |
| `predict_output` (spacing-insensitive compare) | code | 5 |
| `find_error` | judge | 5 |
| `order_steps` (partial credit by pairs; shuffled, never already right) | code | 5 |
| `word_cloze` → `word_meaning` → `word_use` (by card level) | code, then judge | 6 |

**Levels:** recall, explain, apply, analyse, transfer (`QUESTION_LEVELS`). Every stored question is above recall; the recall level is the card's cue ([7.4](#74-recall-check-brain-dump-then-questions)). This replaces the old prompt rule 1 (at least 60% above recall). A card's `level` picks the next question's level.

**Mixed style:** mostly written types, about a quarter choice types, only where wrong options are genuinely tempting (kept from `MIX.mixed`).

**Cut from the old app:** linking questions across sections (`linkSections`, `alsoSectionIds`). Per-idea scheduling makes a question that belongs to two ideas awkward. Listed in [12](#12-open-questions-for-the-owner).

**Acceptance:** the ported `core.test.ts` question, grading and shuffle tests pass in `packages/domain`. `generate.test.ts` passes in `packages/llm`, with the per-idea count rule replacing `questionCountFor`.

### 7.6 Grading

**Problem:** a grade the learner doesn't trust teaches them to ignore it.

**Evidence:** feedback matters (Butler & Roediger, 2008). We found no checked evidence on how reliable LLM grading of short answers is, so we treat it as unverified and measure it ([section 8](#8-metrics-that-show-the-learning-works)).

**Rules**

- Score 0 to 4 from point statuses in code (`scoreRubric`).
- Rating from score: 0 to 1 → `again`, 2 → `hard`, 3 → `good`, 4 → `easy` (`ratingForScore`). Correct means a score of 3 or more.
- Confidence only lowers credit ([7.8](#78-confidence-and-guess-first-old-task-2)).
- **I don't know** → `again`, no AI call.
- The reveal shows:
  - the learner's own answer, with right phrases underlined and wrong ones struck through (judge `marks`, kept only if they are in the answer)
  - the missed points
  - the model answer, which explains from first principles (prompt v8 rule, kept)
  - the quote from the text
- **Count it as right:** once per answer, in Review and on recall results. It sets the rating to `good`, recomputes the schedule from the log, and is logged.
- **Report a problem:** retires the question and doesn't count the answer (the log row stays with `mode = 'practice'`).

**API:** `review.override({ answerId })`, `questions.report({ id, reason })`.

**Acceptance**

- An unreadable judge reply counts every point missing.
- A misconception caps the score at 1.
- An override changes `due_at` to what a `good` answer would have given, and sets `overridden_at`.
- A judge timeout over 20 s leads to self-check, with `graded_by = 'self'`.

### 7.7 Review queue and feedback (old task 3)

**Problem:** one place to keep everything from fading, whenever the learner has a few minutes.

**Evidence:** spacing and retrieval (Cepeda et al., 2006; Latimier et al., 2021). Feedback timing is mixed: lab studies favour delay, classroom studies favour immediate (Kulik & Kulik, 1988; Butler, Karpicke & Roediger, 2007). A wrong choice left uncorrected can be learned (Roediger & Marsh, 2005).

**Decision:** keep old task 3. In Review each answer is checked and its result shown at once. The reasons:

- Review items come from different readings, so earlier answers can't hint at later ones.
- In a long session, feedback at the end arrives after the reasoning behind a mistake is forgotten.
- The spacing benefit that may explain the lab advantage of delayed feedback is already provided by the schedule itself.

The recall check after reading keeps end-of-set feedback, because its questions share one section.

**Behaviour:** route `/mind/review`.

- **Review due ideas:** 1 click (Mind or Home). It shows "14 due · about 6 min" (median answer time × count).
- One card at a time. Small source line ("*Peak* · Chapter 2" or "Lesson · 3 Nov"), the prompt, the answer area.
- **Graded question:** answer → **Guessing / Think so / Sure** (keys 1 / 2 / 3; this is the submit), or **I don't know**. Then the result tile: verdict, the marked answer, the model answer, the quote, "Back in 3 days". Then **Next** (Enter). About 2 clicks a card.
- **Self-rated card** (a lesson or saved idea without a key, or self-check): an optional box ("Type it, or just think it"), **Show answer** (Space), then **Forgot / Hard / Got it** (1 / 2 / 3). 2 clicks.
- After the batch (default 20): "You were sure about these" first, then the right count, **Keep going** (the next 20), **Retry missed ideas** (practice), **Done**.
- **Previous** doesn't exist in Review; each answer is final once checked.
- **Order:** due cards with the lowest predicted recall first, mixing readings, lessons and words. Before FSRS (Release 1): oldest due first, as `review.due` does today.
- **Filter** (one chip row, off by default): All, Readings, Lessons, Words.

**Backlog:** after time away, Review still shows 20 at a time, lowest predicted recall first. No banner of shame, no streak.

**Data:** `review_log` columns from [4.2](#42-changes-to-existing-tables).

**API** (replacing `review.answer`'s input; the web app and `e2e/review.spec.ts` are migrated in the same release, following "migrate callers, then delete")

- `review.next({ limit, filter? })` → `{ items: ReviewItem[], total, minutes }`. `ReviewItem` = card summary + `ask`: `{ kind: 'question', questionId, type, prompt }`, `{ kind: 'cue', prompt, judged }` or `{ kind: 'self', prompt }`.
- `review.answer` input is a discriminated union on `ask`:
  - `{ answerId, cardId, mode, ask: 'question', questionId, response, confidence? }`
  - `{ answerId, cardId, mode, ask: 'cue', text, confidence? }`
  - `{ answerId, cardId, mode, ask: 'self', rating }`
  - output: `{ correct, rating, reveal, dueAt | null }`
- `review.due` stays, for counts on Home and Mind.
- `review.override({ answerId })`.

**Jobs:** none. Grading is inline (one judge call, at most 20 s, then self-check).

**Edge cases**

- The same card answered on two devices: the row lock plus `answer_id` mean the second answer gets `CONFLICT`, and the UI shows "Already answered on another device" and moves on.
- A card whose reading was removed: not served (`deleted_at`).
- A due card whose questions are all retired: asked by cue.
- 300 due cards: still 20 per batch.
- A due card's judge fails: self-check.

**Acceptance**

- e2e `review.spec.ts` rewritten: steps 1, 2 and 3 days, then a 4th gap from FSRS longer than 3 days (Release 2).
- A wrong answer shows the result tile before the next card.
- The same `answerId` sent twice makes one `review_log` row.
- Practice answers don't change `due_at`.
- Lessons and ideas come in one queue.
- Member B can't answer A's card (`NOT_FOUND`), as today.

### 7.8 Confidence and Guess first (old task 2)

**Problem:** learners can't tell lucky guesses from knowledge, and they learn wrong options from multiple choice.

**Evidence:** hypercorrection (Butterfield & Metcalfe, 2001; Metcalfe, 2017). Confidence judged without the answer in view is more accurate (Nelson & Dunlosky, 1991). Lures can be learned (Roediger & Marsh, 2005; Fazio et al., 2010). Generating before seeing options (Bertsch et al., 2007; Kornell, Hays & Bjork, 2009).

**Decision: keep, with two changes.**

1. **Confidence on every graded question, always.** The three buttons *are* the submit, so there is no extra click. Not a setting. They aren't used on self-rated cards, where Forgot / Hard / Got it is already a judgement.
2. **Guess first** (type a few words before multiple-choice options show) becomes **on by default**. The switch stays in three places: the recall start screen, the Review start screen, and Settings → Questions, all one value (`preferences.guess_first`). It ships with multiple choice (Release 4), so no learner sees options without it on day 1.

**Kept from the old build** (`639219c`)

- With Guess first on, options hide behind "Your answer in a few words". **Show options** is enabled only after typing. The guess shows above the options and on the result.
- A right answer marked **Guessing** is spaced like `hard` (`withConfidence`). Confidence never raises credit.
- `easy` needs a perfect written answer given with Sure or no confidence.
- Results open with "You were sure about these", then "Sure: 4 of 5 right · Think so: 2 of 3 · Guessing: 1 of 2".

**Data:** `preferences.guess_first`, `review_log.confidence`, the guess inside `review_log.response`.

**API:** `settings.update({ guessFirst })`; `review.answer` carries `confidence`.

**Acceptance**

- With Guess first on, **Show options** stays disabled until text is typed.
- A correct MCQ answer with `guessing` logs rating `hard`.
- Results list Sure-but-wrong answers first.
- The calibration line counts only answers with a confidence.
- Flipping the switch on the Review start screen changes Settings → Questions.

### 7.9 Saved ideas and mental-model cards

**Problem:** the learner meets an idea worth keeping and wants it back later, linked to where it came from.

**Evidence:** highlighting is low utility (Dunlosky et al., 2013); retrieval is high (same source). So a saved idea becomes a recall card at once.

**Behaviour**

| Operation | Clicks | How |
| --- | --- | --- |
| Save an idea | 2 | Select text → **Save idea** → a small card opens with the quote and two optional fields: "In your words" and "Question to ask yourself". **Save** (Enter). |
| See mental models | 1 | Mind → **Ideas**: every saved idea, grouped by reading, each linking back to its passage. |

- **Answer:** the learner's own words if given (better for generation), otherwise the quote.
- **Cue:**
  - the learner's question, if given
  - otherwise, with a key, the `write-cue` job writes one
  - otherwise the fallback "From *Title*, Section: what did you save here?"

  The fallback is weak; we accept that rather than block saving.
- The card starts at once and is first due in 1 day (step 1), because saving is itself a study event.

**Data:** `cards` with `kind = 'idea'`, `origin = 'member'`, `reading_id`, `section_id`, `quote`.

**API:** `review.add` extended with `{ readingId?, sectionId?, quote? }`; `review.update({ id, prompt?, answer? })`; `review.remove/restore({ id })`; `review.list({ readingId?, origin?, kind? })` for the Ideas page.

**Jobs:** `write-cue`.

**Edge cases**

- A selection across sections: belongs to the section where it starts.
- A selection over 1,000 characters: "Pick one idea, not a page."
- Saving the same quote twice: the second save opens the first card.

**Later:** link one model to several readings (a `card_links` table). Not built now.

**Acceptance**

- e2e: select text → Save idea → Save leaves a card with that quote, due in 1 day, listed on Ideas under its reading.
- With the fake LLM, the cue gets written and doesn't contain the quote's key words.

### 7.10 Life lessons in the same queue

**Problem:** today a logged lesson is an entry, but nothing brings it back. `entries.create` doesn't create a card.

**Evidence:** the same as for any idea: spaced retrieval.

**Behaviour:** + Log → Lesson.

- Two fields: "What did you learn?" and an optional "When does it apply?" (the cue, e.g. "Salary talks").
- **Save**: 1 click, as today. In the same transaction, the server creates the card:
  - `kind = 'lesson'`, `entry_id`
  - `answer` = the text
  - `prompt` = "Salary talks: what's the lesson?" if a cue was given; otherwise the AI-written cue (job), or the fallback "Your lesson from 3 Nov: what was it?"
- A "Remember this" box, ticked by default, lets a lesson be logged without a card.

**Data:** `lesson` details `{ cue? }`; `cards.entry_id`.

**API:** `entries.create` for `lesson` creates the card. `entries.update` of the text updates `cards.answer` and keeps the schedule. `entries.remove/restore` set or clear `cards.deleted_at`. `review.add` with `kind: 'lesson'` stays for other clients.

**Edge cases**

- Undo after Save removes the entry and hides the card.
- A lesson edited after reviews keeps its schedule.
- An empty text is refused, as entries are today.

**Acceptance**

- e2e: logging a lesson makes `review.due` go up by 1 at once.
- Undo takes it back to the old count.
- Editing the text changes the card's answer and not its `due_at`.

### 7.11 Vocabulary

**Problem:** hard words from reading slip away, and some readers want them back.

**Evidence:** retrieval and spacing apply. Interleaving words may hurt (Brunmair & Richter, 2019), so word cards are mixed only because the queue mixes everything; there is a Words filter.

**Behaviour**

| Operation | Clicks | How |
| --- | --- | --- |
| Add a word from the text | 2 | Select a word → **Add word**. The sentence is captured. The meaning is defined in context by AI, or typed when there is no key. |
| Keep a suggested word | 1 | Words the AI suggested are underlined faintly in the reader; click → **Keep**. |
| Add a word by hand | 2 | Mind → **Words** → type the word (and a sentence, optionally) → **Add**. |
| Review words | 1 | Review, or Review with the Words filter. |

- **Test by level:** fill the word into its sentence (exact match, one typo allowed for words of 6 letters or more), then say what it means, then use it in a new sentence (judged). Ported from the old `WORD_TESTS`.
- **Change:** words get per-answer feedback, like everything in Review (see [13](#13-changes-to-earlier-decisions)). Guess first doesn't apply to word tests.
- Suggested words are **not** added automatically. In the old app, up to 3 per section went straight into review, which floods it.

**Data:** `cards` with `kind = 'word'`, `details`; unique `(user_id, lower(details->>'word'))` where `kind = 'word'`.

**API:** `words.add({ id, form, sentence?, meaning?, readingId?, sectionId? })` → `Card`; `words.list()`; `words.suggestions({ sectionId })`.

**Jobs:** `define-word` when added without a meaning and a key exists.

**Edge cases**

- A word already in the vocabulary: opens the existing one and keeps its first sentence.
- A suggested word whose sentence isn't in the section: dropped (`parseTerms`).
- No key and no meaning typed: the card is refused with "Add what it means."

**Acceptance**

- `isSameWord` tests pass.
- Adding the same word twice keeps one card.
- The level-1 test is `word_cloze`, and after two right answers it becomes `word_meaning`.

### 7.12 Teach-back

**Problem:** being able to recall a sentence isn't the same as understanding it.

**Evidence:** self-explanation (Chi et al., 1994) rated moderate utility (Dunlosky et al., 2013); learning by teaching has been studied (Fiorella & Mayer, 2013). There is no checked evidence for an AI playing the student. That is the weakest-evidence feature here, so it is offered, never forced.

**Behaviour**

- **Teach one back** on a missed or vague idea in recall results, on a Review result after a miss, or from a card's menu: 1 click.
- The learner explains the idea without the text. The AI student asks up to 3 short follow-ups that never reveal the answer, then sums up gaps and strengths.
- Gaps found → the card comes back within 10 minutes (`due_at = min(due_at, now + 10 min)`; memory state unchanged). No gaps → no change.
- At most 4 AI calls per session (kept).

**Without a key:** the button shows "Needs your AI key."

**Data:** `teach_sessions`.

**API:** `teach.start({ id, cardId })` → session; `teach.reply({ id, text })` → the next student turn or the summary; `teach.get({ id })`.

**AI:** `teachTurn` (reused), given the section text and the idea.

**Voice later:** teach-back out loud uses the same `teach.reply`, with text from transcription (`source: 'voice'`).

**Acceptance**

- With the fake LLM: three follow-ups, then a summary, never more than 4 calls.
- A summary with gaps sets `due_at` within 10 minutes.
- The student's text never contains the idea's quote, checked in code; a turn that does is replaced with "Can you say more about why?"

### 7.13 Books as goals, finished books as milestones

**Problem:** a book can be a goal ("finish *Peak* by March"), and finishing it is worth keeping.

**Evidence:** none for learning. This is motivation, from the vision.

**Behaviour**

| Operation | Clicks | How |
| --- | --- | --- |
| Set a goal | 2 | Reading menu → **Finish by** → pick a date. |
| Finish a book | 1 | **Finished** at the end of the last section, or in the menu. |

- **Goal:** the reading's tile shows "34% · about 12 pages a day to finish by 1 Mar" (remaining words ÷ days, shown in pages of 300 words).
- **Finished:**
  - sets `finished_at` and creates a `reading.finished` entry
  - shows a milestone card: time spent, ideas kept, recall right on the last reviews, words added
  - offers "Your key lessons from it" (up to 3 lines, prefilled with nothing). Each line becomes a `lesson` card linked to the entry.
  - Undo works, as for entries.
- Finished books appear on Mind under "Finished this year" and in look-back. Path can later read `reading.finished` entries as milestones.

**Data:** `readings.goal_by`, `readings.finished_at`, `readings.finished_entry_id`; the `reading.finished` entry.

**API:** `readings.update({ goalBy })`; `readings.finish({ id, lessons?: string[] })` → `{ entry, cards }`; `readings.unfinish({ id })`.

**Edge cases**

- A goal date in the past shows "Goal date passed", with no nagging.
- Finishing without reading every section is allowed.
- Removing the finished entry clears `finished_at`.

**Acceptance**

- e2e: Finished creates one entry of type `reading.finished` that shows in the Mind entry list.
- Each typed lesson becomes a card.
- Undo removes both.

### 7.14 Skills and deliberate practice

**Problem:** learning a skill (*Peak*) is practice, not reading. The learner needs a goal, a focus for each session, and the next fix.

**Evidence:** deliberate practice (Ericsson et al., 1993; Ericsson & Pool, 2016) explains a share of skill differences, much less in education and professions (Macnamara et al., 2014). Mixed evidence, so this is a light log, not a coaching engine.

**Behaviour**

| Operation | Clicks | How |
| --- | --- | --- |
| Add a skill | 2 | Mind → Skills → **Add skill** → name, an optional goal ("Play the Bach prelude at 80 bpm") and an optional weekly minutes target → **Save**. |
| Log practice | 1 | **Log practice** on the skill (or + Log → Practice). Prefilled: the skill, last time's minutes, and **Worked on** set to last session's **Next time**. Change if needed, **Save**. |
| See a skill | 1 | Click it: minutes per week against the target, sessions, and the trail of "worked on → next time". |

- The form has four fields: Minutes, Worked on, What told you how it went (feedback), and Next time. Only Minutes is required.
- Prefilling **Worked on** from the last **Next time** makes the *Peak* loop (focus, feedback, fix) the default, at zero clicks.
- **One thing I learned** (optional) makes a lesson card.

**Data:** `skills`; `practice` entries.

**API:** `skills.list()`, `skills.create({ id, name, goal?, weeklyMinutes? })`, `skills.update`, `skills.archive({ id })`. Practice uses `entries.create`.

**Edge cases**

- An archived skill keeps its entries.
- Minutes from 1 to 600.
- No target: the skill shows sessions only.

**Acceptance**

- e2e: log practice twice. The second form opens with **Worked on** equal to the first session's **Next time**, and the skill shows the sum of minutes this week.

### 7.15 Mind dashboard and the Home card

**Problem:** the most used operations must take the most prominent place (vision). In Mind those are Review and Continue.

**Behaviour:** `Mind()` in `apps/web/src/pages/worlds.tsx` becomes `apps/web/src/pages/mind/dashboard.tsx`. Top to bottom:

1. **Review 14 · about 6 min** (primary button, 1 click). When nothing is due: "Nothing due. Next: 3 ideas tomorrow."
2. **Continue *Peak* · Chapter 4** (1 click); the last opened reading.
3. **Add a reading** box (paste a link or text, or drop a file).
4. **Reading now:** tiles with progress and goal. **Finished this year:** a row of titles.
5. **Fading:** up to 3 ideas with the lowest predicted recall that aren't due yet, each with **Review now** (Release 2).
6. **Skills:** each skill's week against its target, with **Log practice** (Release 8).
7. **Lessons:** the existing entry list.

Links to **Ideas**, **Words**, **Progress**. One quiet line for paused writing or a missing key.

**Home Mind card** (`apps/web/src/pages/home.tsx`). This decides the vision's open question for Mind:

- the due count, big (exists)
- "Continue: *Peak* · Ch. 4"
- one honest number: "Recalled 86% at review, last 30 days", shown once there are 20 graded reviews

The click opens Mind, as today. Clicking the due count opens Review directly.

**API:** `mind.summary()` → `{ due, minutes, continue, fading[], recall30d, skillsWeek[] }`, one call for both screens.

**Acceptance**

- e2e `worlds.spec.ts`: Mind shows the due count and the Continue line.
- Home shows the 30-day recall only when there are at least 20 graded reviews.
- Clicking Review on Home opens the first due card.

### 7.16 Progress view

**Problem:** the learner needs to know what they know and what is fading, without flattering numbers.

**Evidence:** illusions of competence (Koriat & Bjork, 2005; Bjork et al., 2013): pages read and cards "done" feel like learning. Recall measured at review time is the honest signal.

**Behaviour:** route `/mind/progress`.

| Block | What it shows | Definition |
| --- | --- | --- |
| Ideas | New / Learning / Known / Fading counts, total and per reading | New: not started. Learning: in the 1-2-3 steps. Known: graduated and predicted recall now ≥ 85%. Fading: graduated and predicted recall now < 85%. |
| Recall at review | % right at scheduled reviews, by week, with the member's target as a line | Graduated cards, `mode = 'review'`, first answer of the day per card, excluding overridden and reported answers. |
| Recall by gap | % right after 1 day, 2, 3, 1 to 4 weeks, 1 to 3 months, 3+ months | Grouped by days since the previous review. |
| Brain dumps | Share of key ideas covered, per attempt over time | `recall_attempts.results`. |
| Calibration | "Sure: 91% right · Think so: 70% · Guessing: 35%", and Sure-but-wrong this month | Graded answers with a confidence. |
| Honesty | "You counted 3 of 120 answers as right yourself", "4 questions reported" | `overridden_at`, `questions.report`. |
| Reading | Time per week, books finished, words added | `reading_time`, `readings`, `cards`. |
| Skills | Minutes per week per skill | `practice` entries. |

There are no streaks, no points, and no "mastered 100%". Before FSRS (Release 1), Known means "graduated", and the page says so.

**API:** `progress.summary({ days })`, `progress.reading({ readingId })`.

**Acceptance**

- Unit tests in `apps/server/src/routes/progress.test.ts` build fixtures in `review_log` and check each definition.
- e2e: after 3 graded reviews (2 right), Recall at review shows 67% only once there are 20 reviews; before that it shows "Not enough reviews yet (3 of 20)".

---

## 8. Metrics that show the learning works

All of these come from the member's own tables, computed in SQL in `apps/server/src/routes/progress.ts`. There are no third-party analytics. The owner reads them on their own Progress page. Cross-member numbers are not collected ([12](#12-open-questions-for-the-owner)).

| Metric | Definition | What "working" looks like |
| --- | --- | --- |
| **Retention at review time** | % of scheduled reviews of graduated cards answered right | Within 5 points of `desired_retention` (e.g. 85 to 95% at 0.9). Lower means the scheduler is too optimistic for our varied questions. |
| **Scheduler fit** | Mean `predicted_recall` against actual, in 10 buckets | Each bucket within 10 points. If not, tune FSRS (Release 9) or lower the target. |
| **Recall over time** | % right by gap length (see [7.16](#716-progress-view)) | Flat or slowly falling as gaps grow. A drop at long gaps flags weak ideas. |
| **Brain dump coverage** | Covered ideas ÷ key ideas, per attempt | Rising, or steady while readings get harder. |
| **Calibration** | % right per confidence level; Sure-but-wrong rate | Sure > Think so > Guessing, and Sure ≥ 85%. |
| **Lapse rate** | Lapses per graduated card per month | Falling as cards age. |
| **Work** | Reviews per day and minutes per day | Stable. A rising load with flat retention means too many ideas per section: lower the amount. |
| **Ready on time** | % of recall attempts whose ideas were ready when the dump was submitted | ≥ 90%. Lower means the 30-second trigger is too late. |
| **Question quality** | Reports per 100 questions asked; lint and check rejections per call (`ai_calls`) | Reports < 2 per 100. |
| **Grading trust** | Overrides per 100 judged answers | < 5 per 100. More means the judge or the must-have points are off. |

---

## 9. Reuse map

| Old file (`git show 4051df5^:<path>`) | New home | Reused / changed / new |
| --- | --- | --- |
| `packages/core/src/scheduler.ts` | `packages/domain/src/scheduler.ts` | Already ported as `stepsThenEase`. **Changed** in Release 2 to `stepsThenFsrs`, keeping the 1-2-3 steps and the tests that cover them. |
| `packages/core/src/ideas.ts` | `packages/domain/src/ideas.ts` | `pickQuestion`, levels: **reused**. Mastery (3 days, then 30-day interval): **dropped** for FSRS. |
| `packages/core/src/questions.ts` | `packages/domain/src/questions.ts` | Registry, grading, `scoreRubric`, `withConfidence`, `shuffleMcq`, `orderForTest`, word tests: **reused**. `questionCountFor`: **replaced** by per-idea amounts. |
| `packages/core/src/quality.ts` | `packages/domain/src/quality.ts` | **Reused** as is. |
| `packages/core/src/content.ts` | `packages/domain/src/content.ts` | `Block`, `splitSections`, `sectionText`, `parseMarkdown`: **reused**. The web reader renders `Block[]`. |
| `packages/core/src/html.ts` | `apps/server/src/import/html.ts` | **Reused** (server only; the extension will send HTML to the server). |
| `packages/core/src/core.test.ts`, `html.test.ts` | next to their new files | **Reused**; mastery tests dropped. |
| `packages/llm/src/generate.ts` | `packages/llm/src/write.ts` | `RULES`, `planBatches`, `extractJson`, `parseTerms`, quality check: **reused**. **Changed:** prompt `questions-v9` writes ideas with `cue` and `quote`, and counts per idea. `linkSections`: **dropped**. |
| `packages/llm/src/judge.ts`, `recall.ts`, `tutor.ts`, `words.ts` | same names in `packages/llm/src/` | **Reused**; return usage. `extractIdeas`: **dropped** (folded into `writeSection`). |
| `packages/llm/scripts/eval.ts` + fixtures | `packages/llm/scripts/` | **Reused** to compare prompt versions on the fixture texts before release. |
| `packages/llm/src/providers.ts` | exists | **Changed:** `complete` returns usage. |
| `apps/api/src/jobs.ts` | `apps/server/src/jobs.ts` | Queue options (stately, heartbeats, retries) **reused**. Per-section jobs, `asUser` inside jobs, budget: **new**. |
| `apps/api/src/judge.ts` (`userAi`, `aiFailure`, `judgeFor`) | `apps/server/src/learning/ai.ts` | **Reused**; adds `ai_calls` and the budget. |
| `apps/api/src/routes/recall.ts` | `apps/server/src/routes/recall.ts` | **Changed:** grading in a job, waits for ideas, never writes ideas. |
| `apps/api/src/routes/study.ts` | `apps/server/src/routes/review.ts` | Answer grading and `questionsFor`: **reused** inside `review.answer` and `review.next`. Daily cap and `/today`: **dropped**. |
| `apps/api/src/routes/library.ts` | `apps/server/src/routes/readings.ts` | Listing, delete: **reused**. `generateQuiz` and Manage test: **dropped**. |
| `apps/api/src/routes/web.ts`, `web/fetch.ts`, `web/extract.ts` | `apps/server/src/import/` | **Reused**, with their tests (SSRF rules, 28 XSS payloads). Collections/buckets: **later**. |
| `apps/api/src/routes/books.ts`, `books/pdf.ts`, `books/epub.ts`, `media.ts` | `apps/server/src/import/` | **Reused**; media bytes move to the `media` table. |
| `apps/api/src/routes/words.ts` | `apps/server/src/routes/words.ts` | **Changed:** words are cards in the main queue. |
| `apps/api/src/routes/notes.ts` | `apps/server/src/routes/teach.ts` | Teach-back: **reused** with its own table. Explanations: Release 5. |
| `apps/api/src/routes/sessions.ts` | — | **Dropped** (focus sessions). |
| `apps/mobile/src/practice.tsx`, `recall.tsx`, `app/test/[id].tsx`, `app/(tabs)/review.tsx` | `apps/web/src/practice/*`, `pages/mind/recall.tsx`, `pages/mind/review.tsx` | Flow and states **reused**; UI **rewritten** for React DOM and Tailwind (the old app was React Native). |
| `apps/mobile/src/app/read/[id].tsx` | `apps/web/src/pages/mind/reader.tsx` | Section tracking **reused**; focus timer dropped. |
| `apps/mobile/src/app/manage/[id].tsx` | — | **Dropped**; replaced by Settings → Questions and Rewrite questions. |
| `apps/mobile/src/app/teach/[id].tsx`, `words.tsx` | `pages/mind/teach.tsx`, `pages/mind/words.tsx` | Flow **reused**, UI rewritten. |
| — | `skills`, `reading.finished`, goals, progress, Home summary, sample reading, budget | **New**. |

---

## 10. Release plan

Each release sits on the one before, works on its own, and ends with `pnpm typecheck`, `pnpm test` and `pnpm e2e` green.

### Release 1: read → recall → review (smallest complete loop)

**Ships**

- `readings.add` for links and pasted text, with the reused import code. No images (alt text kept), no files.
- Reader at `/mind/read/$id`: sections, contents, position memory, the Recall card at each section's end, the 30-second seen trigger.
- `write-section` job: key ideas with cue and quote, and `short_answer` questions (Standard amount); lint and the second-pass check; `ai_calls`; monthly budget.
- Recall check: brain dump → AI grading job → questions, missed ideas first → results at the end with the recall map; Retry missed ideas.
- Cards per key idea on the existing `stepsThenEase` scheduler, with `started_at`, `answer_id`, and the new `review_log` columns.
- Review at `/mind/review`: per-answer feedback, confidence buttons, cue recall, self-rated cards, Count it as right, Report a problem.
- Lessons make cards ([7.10](#710-life-lessons-in-the-same-queue)).
- No-key path: sample reading, self-check of dumps and written answers.
- Mind dashboard: Review, Continue, Add, Reading now. Home card: due count and Continue.
- `e2e/fake-llm.ts` answers completions.

**Exit criteria**

- e2e: add a link → stay 30 s → Recall → dump → answer → results → a covered idea is due in 1 day → make it due → Review → answer right → due in 2 days.
- No-key e2e: the sample reading's loop, start to finish.
- e2e: a lesson card appears in Review.
- The budget stops a second section's writing in a test with a $0 budget.
- RLS tests: member B can't see A's readings, cards, questions, attempts or AI calls.
- The owner uses it on one real article for a week.

### Release 2: FSRS and honest progress

**Ships**

- `stepsThenFsrs`, the lapse change, `predicted_recall`, the `replay-schedules` CLI.
- Settings → Review target.
- Lowest-predicted-recall order.
- Fading on Mind.
- Progress view v1: ideas by status, recall at review, recall by gap, brain dump coverage.
- Home 30-day recall.

**Exit criteria**

- Unit tests: steps 1, 2, 3, then an FSRS gap; lapse rules; replay idempotence.
- The replay run on a copy of the owner's database matches the expected counts.
- Progress definitions are tested against fixtures.

### Release 3: books

**Ships**

- `readings.addFile` (PDF, EPUB, 50 MB), PDF links, images into `media`.
- Recall chapter, chapter batches in `write-section`.
- Finish by (goal) and Finished (milestone entry, key lessons → cards).
- Reading time.

**Exit criteria**

- Ported `books.test.ts`.
- e2e: drop an EPUB fixture → read chapter 1 → Recall chapter.
- e2e: Finished makes an entry and lesson cards; Undo removes them.

### Release 4: saved ideas, multiple choice and Guess first

**Ships**

- Select → Save idea, the Ideas page, `write-cue`.
- `mcq` questions with `whyWrong`.
- Guess first (on by default) with its three switches.
- Calibration line on results and on Progress.

**Exit criteria**

- e2e for Save idea and Guess first ([7.8](#78-confidence-and-guess-first-old-task-2), [7.9](#79-saved-ideas-and-mental-model-cards)).
- Unit test: `withConfidence` mapping.

### Release 5: deeper questions

**Ships**

- `worked_problem`, `predict_output`, `find_error`, `order_steps`.
- `top-up-questions` job.
- Settings → Questions (amount, kinds, check twice) and Rewrite questions.
- Explain a passage.

**Exit criteria**

- Ported grading tests.
- e2e: Rewrite keeps history.
- The `eval.ts` run on the fixtures shows lint pass rates no lower than `questions-v8`.

### Release 6: vocabulary

**Ships**

- Add word (selection and by hand), suggested words, `define-word`.
- Word tests by level in the main queue; the Words page and filter.

**Exit criteria:** see [7.11](#711-vocabulary).

### Release 7: teach-back

**Ships:** teach-back from results, Review and the card menu.

**Exit criteria:** see [7.12](#712-teach-back).

### Release 8: skills

**Ships**

- The `skills` table, `practice` entries with prefilled focus.
- The Skills card on Mind; skill minutes on Progress.

**Exit criteria:** see [7.14](#714-skills-and-deliberate-practice).

### Release 9: tuning and the full progress view

**Ships**

- Per-member FSRS parameter tuning (monthly job, after 1,000 reviews).
- Scheduler-fit chart.
- Calibration, honesty and skills blocks complete.
- Settings → AI usage history.

**Exit criteria**

- Tuning changes parameters only when the fit on held-out reviews improves.
- The scheduler-fit chart matches a fixture.

### Later

- Chrome extension capture (`readings.capture`).
- Voice for brain dumps and teach-back (the `source: 'voice'` field is already there).
- Phone app: reminders and notifications, using the same contract.
- Importing linked pages, buckets.

---

## 11. Risks

| Risk | Effect | Cheapest early check |
| --- | --- | --- |
| AI cost surprises a member | Trust lost, key removed | Release 1 ships `ai_calls` and the budget. The owner reads a week of usage before inviting anyone. |
| Judge grades unfairly | Learners stop trusting grades | Count it as right plus the override metric; review 50 judged answers by hand in Release 1. |
| Key ideas wrong or missing the point | Recall checks against the wrong thing | Quote guard; learner edits; `eval.ts` fixtures; Report a problem. |
| FSRS fits varied questions badly | Retention at review far from target | `predicted_recall` vs actual from Release 2; lower the target or tune. |
| Too many cards per section | Review load grows and the learner quits | Standard = one question per key idea; no padding to the one-per-150-words guide; at most 20 ideas per section; the Work metric; the amount setting. |
| 30-second trigger too late or too early | Waiting at recall, or spend on skimmed sections | The Ready-on-time metric; change the threshold in one constant. |
| Prompt injection from web pages | Odd questions or output | Tags, schema parse, quote checks, plain-text rendering. |
| Weak fallback cues without a key | Lessons and saved ideas are hard to recall from "what did you save here?" | Ask for the cue in the form; measure their recall at review separately. |
| Replay migration bug | Wrong due dates | Run on a copy first; it is deterministic and the log is never rewritten. |
| Contract change to `review.answer` | Breaks the web app and e2e in one go | Same release migrates `apps/web` and `e2e/review.spec.ts`; old shape deleted. |

---

## 12. Open questions for the owner

Each has a recommendation; the spec assumes it until told otherwise.

1. **Monthly AI budget default.** Recommend $5 per member, editable.
2. **Guess first on by default.** Recommend on. It adds typing on about a quarter of questions. Overrule → off, nothing else changes.
3. **Lapse rule.** Recommend 10 minutes → 1 day → FSRS, instead of restarting 1-2-3 after a graduated card is forgotten.
4. **Vocabulary feedback.** Recommend per-answer, like the rest of Review (reverses the old decision).
5. **Count it as right.** Recommend allowed once per answer, logged and shown on Progress. Overrule → judge is final, self-check only on failure.
6. **Cross-member metrics.** Recommend none: each member sees only their own. If the owner wants to judge the app across the circle, a later opt-in anonymous count (no text) could be added.
7. **Linking questions across sections** (old `linkSections`). Recommend leaving them out until per-idea review is settled.
8. **Encrypting reading text and brain dumps.** Today only notes about people are encrypted. Recommend not encrypting readings (search needs them) but encrypting `recall_attempts.text` and `teach_sessions.messages`, which can be personal. Decide before Release 1.
9. **Sample reading.** Recommend a short text written by us on how memory works. The owner may prefer a public-domain extract.
10. **Images in Postgres.** Fine until hosting is chosen; revisit then.
11. **Home summaries for Body and Heart.** This spec decides only Mind's card.

---

## 13. Changes to earlier decisions

| Earlier decision | Where | Now | Reason |
| --- | --- | --- | --- |
| Questions only from Manage test | Old task 1 | Written in the background after 30 s in a section; Recall as fallback; Manage test removed | [7.3](#73-key-ideas-and-questions-when-they-get-written-old-task-1) |
| Guess first off by default | Old task 2 | On by default; confidence always shown | [7.8](#78-confidence-and-guess-first-old-task-2) |
| Vocabulary keeps end-of-session feedback, no Guess first | Old tasks 2, 3 | Per-answer feedback (same queue); still no Guess first | One Review mode; nothing in a word test hints at another word. |
| Forgetting restarts the 1-2-3 steps | `README.md`, `scheduler.ts` | Only for cards still in the steps; graduated cards relearn 10 min → 1 day → FSRS | [5.2](#52-rules-stepsthenfsrs-in-packagesdomainsrcschedulerts-behind-the-existing-scheduler-type) |
| Mastery after 3 correct days, then monthly | old `ideas.ts` | FSRS predicted recall | [5.3](#53-per-idea-scheduling) |
| Daily review cap (80) | old `users.daily_review_cap` | Batches of 20 with Keep going | Not tied to a schedule. |
| Up to 3 words per section added to review | old prompt v7 | Suggested, kept with one click | Stops review flooding. |
| Focus sessions | old `sessions.ts` | Dropped; reading time recorded quietly | Not in the vision; extra step. |

---

## 14. References

Checked against the publisher, PubMed, Crossref or ERIC records in November 2026, unless marked.

- Adesope, O. O., Trevisan, D. A., & Sundararajan, N. (2017). Rethinking the use of tests: A meta-analysis of practice testing. *Review of Educational Research*, 87(3), 659–701.
- Bertsch, S., Pesta, B. J., Wiscott, R., & McDaniel, M. A. (2007). The generation effect: A meta-analytic review. *Memory & Cognition*, 35(2), 201–210.
- Bjork, E. L., & Bjork, R. A. (2011). Making things hard on yourself, but in a good way: Creating desirable difficulties to enhance learning. In M. A. Gernsbacher, R. W. Pew, L. M. Hough, & J. R. Pomerantz (Eds.), *Psychology and the real world*. Worth. (Checked through later papers that cite it, not the book itself.)
- Bjork, R. A. (1994). Memory and metamemory considerations in the training of human beings. In J. Metcalfe & A. P. Shimamura (Eds.), *Metacognition: Knowing about knowing*. MIT Press.
- Bjork, R. A., Dunlosky, J., & Kornell, N. (2013). Self-regulated learning: Beliefs, techniques, and illusions. *Annual Review of Psychology*, 64, 417–444.
- Brunmair, M., & Richter, T. (2019). Similarity matters: A meta-analysis of interleaved learning and its moderators. *Psychological Bulletin*, 145(11), 1029–1052.
- Butler, A. C., Karpicke, J. D., & Roediger, H. L. III (2007). The effect of type and timing of feedback on learning from multiple-choice tests. *Journal of Experimental Psychology: Applied*, 13(4), 273–281.
- Butler, A. C., & Roediger, H. L. III (2008). Feedback enhances the positive effects and reduces the negative effects of multiple-choice testing. *Memory & Cognition*, 36(3), 604–616.
- Butterfield, B., & Metcalfe, J. (2001). Errors committed with high confidence are hypercorrected. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, 27(6), 1491–1494.
- Cepeda, N. J., Pashler, H., Vul, E., Wixted, J. T., & Rohrer, D. (2006). Distributed practice in verbal recall tasks: A review and quantitative synthesis. *Psychological Bulletin*, 132(3), 354–380.
- Cepeda, N. J., Vul, E., Rohrer, D., Wixted, J. T., & Pashler, H. (2008). Spacing effects in learning: A temporal ridgeline of optimal retention. *Psychological Science*, 19(11), 1095–1102. (Its specific gap ratios are not used here.)
- Chi, M. T. H., de Leeuw, N., Chiu, M.-H., & LaVancher, C. (1994). Eliciting self-explanations improves understanding. *Cognitive Science*, 18(3), 439–477.
- Clark, J. M., & Paivio, A. (1991). Dual coding theory and education. *Educational Psychology Review*, 3(3), 149–210. (Only the theory's main claim is used.)
- Dunlosky, J., Rawson, K. A., Marsh, E. J., Nathan, M. J., & Willingham, D. T. (2013). Improving students' learning with effective learning techniques. *Psychological Science in the Public Interest*, 14(1), 4–58.
- Ericsson, K. A., Krampe, R. T., & Tesch-Römer, C. (1993). The role of deliberate practice in the acquisition of expert performance. *Psychological Review*, 100(3), 363–406.
- Ericsson, A., & Pool, R. (2016). *Peak: Secrets from the new science of expertise*. Houghton Mifflin Harcourt.
- Fazio, L. K., Agarwal, P. K., Marsh, E. J., & Roediger, H. L. (2010). Memorial consequences of multiple-choice testing on immediate and delayed tests. *Memory & Cognition*, 38(4), 407–418.
- Fiorella, L., & Mayer, R. E. (2013). The relative benefits of learning by teaching and teaching expectancy. *Contemporary Educational Psychology*, 38(4), 281–288. (Record checked; its findings were not verified, so no effect is claimed.)
- James, K. K., & Storm, B. C. (2019). Beyond the pretesting effect: What happens to the information that is not pretested? *Journal of Experimental Psychology: Applied*, 25(4), 576–587.
- Karpicke, J. D., & Blunt, J. R. (2011). Retrieval practice produces more learning than elaborative studying with concept mapping. *Science*, 331(6018), 772–775.
- Karpicke, J. D., & Roediger, H. L. III (2007). Expanding retrieval practice promotes short-term retention, but equally spaced retrieval enhances long-term retention. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, 33(4), 704–719.
- Koriat, A., & Bjork, R. A. (2005). Illusions of competence in monitoring one's knowledge during study. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, 31(2), 187–194.
- Kornell, N., & Bjork, R. A. (2008). Learning concepts and categories: Is spacing the "enemy of induction"? *Psychological Science*, 19(6), 585–592.
- Kornell, N., Hays, M. J., & Bjork, R. A. (2009). Unsuccessful retrieval attempts enhance subsequent learning. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, 35(4), 989–998.
- Kulik, J. A., & Kulik, C.-L. C. (1988). Timing of feedback and verbal learning. *Review of Educational Research*, 58(1), 79–97.
- Latimier, A., Peyre, H., & Ramus, F. (2021). A meta-analytic review of the benefit of spacing out retrieval practice episodes on retention. *Educational Psychology Review*, 33(3), 959–987.
- Macnamara, B. N., Hambrick, D. Z., & Oswald, F. L. (2014). Deliberate practice and performance in music, games, sports, education, and professions: A meta-analysis. *Psychological Science*, 25(8), 1608–1618.
- Metcalfe, J. (2017). Learning from errors. *Annual Review of Psychology*, 68, 465–489.
- Nelson, T. O., & Dunlosky, J. (1991). When people's judgments of learning (JOLs) are extremely accurate at predicting subsequent recall: The "delayed-JOL effect". *Psychological Science*, 2(4), 267–271.
- Pan, S. C., & Carpenter, S. K. (2023). Prequestioning and pretesting effects: A review of empirical research, theoretical perspectives, and implications for educational practice. *Educational Psychology Review*, 35, Article 97.
- Rawson, K. A., & Dunlosky, J. (2011). Optimizing schedules of retrieval practice for durable and efficient learning: How much is enough? *Journal of Experimental Psychology: General*, 140(3), 283–302.
- Richland, L. E., Kornell, N., & Kao, L. S. (2009). The pretesting effect: Do unsuccessful retrieval attempts enhance learning? *Journal of Experimental Psychology: Applied*, 15(3), 243–257.
- Roediger, H. L. III, & Karpicke, J. D. (2006). Test-enhanced learning: Taking memory tests improves long-term retention. *Psychological Science*, 17(3), 249–255.
- Roediger, H. L. III, & Marsh, E. J. (2005). The positive and negative consequences of multiple-choice testing. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, 31(5), 1155–1159.
- Rohrer, D., & Taylor, K. (2007). The shuffling of mathematics problems improves learning. *Instructional Science*, 35(6), 481–498.
- Rowland, C. A. (2014). The effect of testing versus restudy on retention: A meta-analytic review of the testing effect. *Psychological Bulletin*, 140(6), 1432–1463.
- Slamecka, N. J., & Graf, P. (1978). The generation effect: Delineation of a phenomenon. *Journal of Experimental Psychology: Human Learning and Memory*, 4(6), 592–604.
- Su, J., Ye, J., Nie, L., Cao, Y., & Chen, Y. (2023). Optimizing spaced repetition schedule by capturing the dynamics of memory. *IEEE Transactions on Knowledge and Data Engineering*, 35(10), 10085–10097.
- Yang, C., Luo, L., Vadillo, M. A., Yu, R., & Shanks, D. R. (2021). Testing (quizzing) boosts classroom learning: A systematic and meta-analytic review. *Psychological Bulletin*, 147(4), 399–435.
- Ye, J., Su, J., & Cao, Y. (2022). A stochastic shortest path algorithm for optimizing spaced repetition scheduling. *Proceedings of the 28th ACM SIGKDD Conference on Knowledge Discovery and Data Mining*, 4381–4390.

Software and data, checked November 2026:

- open-spaced-repetition, `srs-benchmark` (GitHub): datasets of about 10,000 to 20,000 Anki users depending on version; metrics are log loss, AUC and RMSE (bins).
- open-spaced-repetition, `ts-fsrs` 6.0.0 (npm, MIT, Node ≥ 24): `desiredRetention`, `maximumInterval`, learning steps, `enableFuzz`, `forgettingCurve`; optimiser in `@open-spaced-repetition/binding`.
- Anki FAQ, "What spaced repetition algorithm does Anki use?": FSRS available since Anki 23.10.
