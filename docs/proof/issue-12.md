# Issue #12: Review due ideas with feedback after each answer

Release 1, task 7 of 31. Spec: `learning_spec.md` sections 7.7 (Review queue and feedback), 5.3 (per-idea scheduling), 7.6 (Count it as right, Report a problem) and 7.8 (confidence only).

## What was built

- **Review at `/mind/review`.** One click from the due count on Home (**Review due ideas** on the Mind card) or on Mind (the **Due for review** tile). The page shows "14 due · about 6 min": the count times the member's median time per answer over their last 200 answers (gaps over 5 minutes are breaks; 25 seconds each until there are at least 5 gaps).
- **One card at a time**, with a small source line ("JavaScript execution model · The engine and the host", or "Lesson · 9 Nov"), the prompt and the answer area. "Card 3 of 20" shows the place in the batch.
- **What is asked** (`review.next`, spec 5.3):
  - a stored question not asked yet, nearest the card's level, lower levels first after a miss (`pickQuestion`);
  - otherwise the card's cue, as a written recall judged against the idea;
  - without an AI key, every card is self-rated.
- **Graded question or cue.** Answer, then **Guessing / Think so / Sure** (keys 1, 2 and 3 once the box is left; they are the submit), or **I don't know**. The result tile shows at once: the verdict, what the member wrote, the judge's feedback, the points made or missed, the model answer, the quote and "Back in 2 days". **Next** is focused, so Enter goes on.
- **Self-rated card.** An optional box ("Type it, or just think it"), **Show answer** (focused, so Space shows it), then **Forgot / Hard / Got it** (keys 1, 2 and 3).
- **When the judge fails** (provider error or unreadable reply), the card turns into a self-check: "Your answer couldn't be checked just now. Check it yourself.", what the member wrote, the idea, then **Forgot / Hard / Got it**. The answer is logged with `graded_by = 'self'`.
- **Count it as right** (`review.override`). On a written answer the judge marked wrong, once per answer, in Review and on the recall results. The answer becomes `good` and right, `overridden_at` is set, and the card's schedule and level are worked out again from the log as if it had been graded right. The tile then says "Counted as right" with the new due time.
- **Report a problem** (`questions.report`). Under a stored question, before or after answering: three reasons (The answer is wrong, The question is unclear, It isn't in the text). The question is retired and never asked again, and the reason is kept in `questions.report`. An answer already given to it stops counting: its log row becomes `mode = 'practice'`, and the card's schedule is worked out again without it.
- **Batches of 20.** After a batch: "You answered N of M right", **You were sure about these** (wrong answers given with Sure) first, then **Keep going** (the next 20) when more are due, **Retry missed ideas** (each wrong written answer again through its cue, as practice: the schedule stays), and **Done** (back to Mind).
- **Filter chips:** All, Readings, Lessons, Words. Off (All) by default.
- **Order:** oldest due first, mixing readings and lessons. Lowest predicted recall first comes with FSRS (Release 2).
- **Already answered on another device.** An answer to a card that is no longer due (`CONFLICT`) shows that line and moves on.

## Behaviour that changed

- The due counts on Home and Mind now open Review. The Mind tile also shows "about N min".
- `review.due` returns `minutes` too.
- Each new `review_log` row keeps the card's schedule and level from just before the answer (`prev`, migration `0017_review_log_prev.sql`), so an override or a report can work the schedule out again from that point. Rows from before have no `prev`, and the API refuses to change them with "This answer is too old to change."
- Recall results (#11) now offer **Count it as right** on wrong written answers too.
- In Review, the keys 1 to 3 answer the card instead of switching worlds. They are caught before the shell's shortcuts and never while typing.

## Decisions

- **How an override reschedules.** The spec says "recomputes the schedule from the log". The replay starts from the card's state just before the answer (`prev`) and applies every later answer that counts, in order, each at the time it was given. Practice answers are skipped.
- **What can be counted as right:** only a written answer that was judged wrong. A self-rated answer (the member already rated it) and **I don't know** (nothing to count) are refused with a plain message.
- **Retry missed ideas** in Review asks the cue, like the recall retry in #11, so the stored questions stay unasked for later reviews. Self-rated cards have nothing to retry.
- **Order before FSRS** stays oldest due first, as `review.due` did.

## Bug fixed on the way

- The proof screenshots of scrolled pages drew the top bar in the middle of the page. `e2e/proof.ts` now scrolls to the top before each full-page capture.

## Proof

UI tests (in `e2e/mind-read.spec.ts`, at desktop and phone sizes):

- **Review: an idea covered in recall, once due, is back in 2 days when answered right, and in 10 minutes a level lower when wrong.** This is the issue's acceptance test. Read a section, recall it, answer its deeper question right (the card is at level 2). Make it due. On Home the due count is 1, and **Review due ideas** opens `/mind/review` with "1 due · about 1 min" and the source line. Its stored question was asked in the recall, so Review asks its cue. Right (with the 2 key on desktop): "Back in 2 days", level 3, due in 2 days (± 1 minute). Due again and answered wrong with Sure: "Back in 10 minutes", level 2, due in 10 minutes. The summary lists it under **You were sure about these**. **Retry missed ideas** asks the cue again as practice; the result shows no due time, and the card's level and due time do not change.
- **Count it as right on a wrong answer in Review schedules it as a right one, once; when the judge fails, the member checks it.** A wrong answer says "Not quite" and "Back in 10 minutes". **Count it as right** turns it into "Counted as right" and "Back tomorrow", and the button goes away; the card is at level 2, due in 1 day. On the next card the fake AI fails: the member sees the self-check, picks **Got it**, and the log row is `ask = 'self'`, `graded_by = 'self'`, `rating = 'good'`. The summary says 2 of 2 right, with no **You were sure about these**.
- **Report a problem on a question in Review retires it, and the answer to it does not count.** After a right answer, **Report a problem** shows the three reasons; **It isn't in the text** shows "Thanks. This question won't be asked again, and this answer doesn't count." The question is retired with `not_in_text`, the log row is practice, and the card is back exactly as it was. Reloaded, the card is still due and is asked by its cue, with no report link.
- **Review without a key: self-rated cards, 20 at a time with Keep going, filters, and answer keys that never switch worlds.** 21 lessons: Mind shows "21" and "about 9 min". Readings is empty with a calm line; Lessons shows "Card 1 of 20" and "Lesson · 9 Nov". On desktop, Space shows the answer and 1 rates Forgot and stays on Review. After 20: "You answered 19 of 20 right." with **Keep going** and no retry; **Keep going** brings card 21. The log has 21 self-rated rows. **Done** goes to Mind, where 0 are due.

API tests (in `e2e/review.spec.ts`):

- **Review asks a question not asked yet nearest the card's level, then the cue; without a key every card is self-rated.** At level 2 it asks apply; right goes to level 3 and asks analyze; a miss goes back to 2 and the nearest unasked one, explain, comes next; when all are asked, the cue. Filters keep lessons and ideas apart. A member without a key gets `{ kind: 'self' }`.
- **Count it as right** makes a wrong Sure answer `good`, level 2 and due in 1 day, keeps the confidence, and gives the same result when asked twice. It is refused for a self-rated answer and for I don't know, and another member gets `NOT_FOUND`.
- **Report a problem** retires the question, makes the answer practice, puts the card back as it was, and moves Review to the next question, then to the cue. Another member gets `NOT_FOUND`.
- The existing tests still pass: steps 1, 2 and 3 days then a longer gap; the same `answerId` twice makes one log row; a member can't answer another member's card.
- Full run: `pnpm typecheck`, `pnpm test` (161 tests) and `pnpm e2e` (105 passed, 21 skipped) are green.

The fake AI fails the judge when an answer contains `JUDGE_FAILS`, so a test can reach the self-check path.

| Desktop | Phone |
| --- | --- |
| ![Review: a due idea asked through its cue, desktop](issue-12/desktop-review-question.png) | ![Review: a due idea asked through its cue, phone](issue-12/phone-review-question.png) |
| ![A right answer: Back in 2 days, desktop](issue-12/desktop-review-right.png) | ![A right answer: Back in 2 days, phone](issue-12/phone-review-right.png) |
| ![A wrong answer: Back in 10 minutes, desktop](issue-12/desktop-review-wrong.png) | ![A wrong answer: Back in 10 minutes, phone](issue-12/phone-review-wrong.png) |
| ![The summary: You were sure about these, desktop](issue-12/desktop-review-summary-sure.png) | ![The summary: You were sure about these, phone](issue-12/phone-review-summary-sure.png) |
| ![Retry missed ideas, as practice, desktop](issue-12/desktop-review-retry.png) | ![Retry missed ideas, as practice, phone](issue-12/phone-review-retry.png) |
| ![Count it as right, desktop](issue-12/desktop-count-it-as-right.png) | ![Count it as right, phone](issue-12/phone-count-it-as-right.png) |
| ![The judge failed: the member checks the answer, desktop](issue-12/desktop-self-check.png) | ![The judge failed: the member checks the answer, phone](issue-12/phone-self-check.png) |
| ![Report a problem: the three reasons, desktop](issue-12/desktop-report-reasons.png) | ![Report a problem: the three reasons, phone](issue-12/phone-report-reasons.png) |
| ![Reported: the question is retired, desktop](issue-12/desktop-reported.png) | ![Reported: the question is retired, phone](issue-12/phone-reported.png) |
| ![A self-rated lesson, desktop](issue-12/desktop-self-rated.png) | ![A self-rated lesson, phone](issue-12/phone-self-rated.png) |
| ![Show answer, then Forgot, Hard or Got it, desktop](issue-12/desktop-self-rated-shown.png) | ![Show answer, then Forgot, Hard or Got it, phone](issue-12/phone-self-rated-shown.png) |
| ![After 20 cards: Keep going, desktop](issue-12/desktop-batch-summary.png) | ![After 20 cards: Keep going, phone](issue-12/phone-batch-summary.png) |

On phones, the fixed bottom bar sits over the end of a long page in a full-page capture; on a real phone the page has room under its last line, so nothing is hidden.

Run again with `PROOF=issue-12 pnpm exec playwright test e2e/mind-read.spec.ts -g "Review|Count it|Report a problem"`.
