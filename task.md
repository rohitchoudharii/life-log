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

## 4. How an article is split into sections

**Status:** decided, not built. The new server has no import code yet. The old splitter is `splitSections` in `packages/core/src/content.ts` (`git show 4051df5^:packages/core/src/content.ts`), which cut every run without headings near 450 words. That was too small: a 1,100-word article became three recall steps.

A section is the unit of recall: read one section, brain dump, then its questions. The rules:

1. **The author's headings are the boundaries.** Each heading starts a section, and heading levels become section levels (at most three), as in the old splitter.
2. **Cut only past 2,500 words.** A section with more than about 2,500 words of text is cut at a block boundary, never inside a paragraph. No AI and no topic detection for this cut: most sections cover few topics, so a word count is enough.
3. **An article with no headings gets headings from the AI, with the text unchanged.** When the extracted article has no headings in its body and has 1,000 words or more, ask the LLM to add headings where the topic changes. Then split as in rule 1.

### Rule 3: the LLM adds headings, it does not rewrite the article

Don't ask the LLM to return the whole article as HTML. It can drop, merge or reword sentences even when told not to, and the output costs as many tokens as the article.

Instead:

- Send the blocks with a number on each, for example `[1] First paragraph…`, `[2] …`.
- The LLM returns only where headings go and what they say: `[{ "before": 7, "title": "Why dead rows exist", "level": 2 }]`.
- Code inserts those headings as `heading` blocks. Every word of the article stays as extracted, by construction, and the output is a few hundred tokens.
- Check the reply: block numbers in range and in order, no empty titles, levels 2 or 3. If the reply is invalid, or the member has no AI key, keep the article as one section (rule 2 still applies).
- Mark AI-written headings (for example `source: 'ai'` on the block) so the reader can show them a little differently from the author's headings.

### Decided

- An article with no headings and under about 1,000 words skips rule 3 and stays one section.
- The LLM decides how many headings to add. There is no target count.

## 5. How EPUB and PDF books are split into sections

**Status:** decided, not built. The old parsers are `apps/api/src/books/epub.ts` and `apps/api/src/books/pdf.ts` (`git show 4051df5^:<path>`). A book chapter is treated like an article: item 4's rules (author's headings, cut past 2,500 words) apply inside each chapter.

### What the old parsers already do

- **EPUB:** reads the spine in order; chapter titles come from the EPUB 3 `nav.xhtml` or the EPUB 2 NCX, including several chapters in one file; each chapter is a level 1 section and its own headings nest below it. It drops chunks under 60 words with no images (covers, title pages, copyright), Project Gutenberg's front page and licence, and a chapter heading that repeats the title. It refuses DRM books and zip bombs.
- **PDF:** reads text with pdf.js; drops repeated headers, footers and page numbers; reads two-column pages left column first; joins hyphenated words across lines. Headings are lines set larger than the body text or numbered lines ("3.1 Encoder"), nested by size or numbering. It keeps a `page` block per page, and refuses scanned PDFs with no text.

### Changes

1. **Use the book's own outline first.** EPUB: keep the table of contents nesting (Part → Chapter → subsection, at most three levels) instead of making every entry level 1; a part page with little text stays as a parent instead of being dropped by the 60-word rule. PDF: read the outline (bookmarks) with pdf.js `getOutline()` and use it for chapters when the PDF has one; the font-size headings are the fallback.
2. **Front and back matter are recognised, not guessed from length.** Use EPUB 3 `epub:type` and the `landmarks` nav (`frontmatter`, `backmatter`, `toc`, `index`, `endnotes`, `bibliography`, `copyright-page`), then title patterns for EPUB 2 and PDF ("Contents", "Index", "Notes", "References", "Bibliography", "Acknowledgements", "About the author", "Also by"). PDF table of contents pages are also caught by their dot leaders and page numbers.
   - Dropped: cover, title page, copyright, the table of contents page, index, acknowledgements, about the author, "Also by". The notes section is not a section either; its notes only feed the popups in rule 3.
   - Kept to read, but no questions and not counted in progress: references and bibliography.
   - Kept as normal sections: foreword, preface, introduction, epilogue, appendices.
3. **Notes.** Endnotes and footnotes open from their marker in the text (a small popup), and are never part of a section's recall. In PDFs, small lines at the bottom of a page after a note marker are footnotes, not body text.
4. **A chapter with no headings** is one section up to 2,500 words. A chapter longer than that gets item 4's AI headings, so its parts get real titles instead of "part 2". If the AI step fails or the member has no AI key, the chapter is cut at a block past 2,500 words.
5. **A PDF with no outline and no detectable headings** is treated as an article: item 4's rules, including AI headings.

### Decided

- AI headings run only on chapters with no headings that are longer than 2,500 words. A shorter chapter is one section anyway.
- References and bibliography are kept to read without questions; the rest of the back matter is dropped.
- Scanned PDFs are refused for now, with the message "This PDF is scanned pages without text". OCR is item 7.

## 6. Books on the web with one page per chapter

**Status:** proposed, not built. Examples: mdBook books (The Rust Book), *Software Engineering at Google* on abseil.io, *Crafting Interpreters*, *Eloquent JavaScript*, *Pro Git*, and books built with GitBook, Docusaurus, Sphinx, MkDocs, Bookdown, Quarto or Jupyter Book.

The member pastes any page of the book (the contents page or a chapter). The app imports the whole book as one reading: one chapter page becomes one level 1 section, and item 5's rules apply inside each chapter.

### Finding the chapters, cheapest first

1. **A single-page version.** mdBook's `print.html`, Sphinx's `singlehtml`, and similar. One fetch, with every heading in place; split it at its chapter headings.
2. **The generator's own navigation.** Detect the generator from `<meta name="generator">` or its markup (mdBook's sidebar, Docusaurus's sidebar, Sphinx's toctree, GitBook's summary) and read its ordered chapter list.
3. **`llms.txt`** when the site publishes one.
4. **The contents list on the page.** The longest ordered list of same-site links under the book's path, usually in a sidebar or on the contents page. Link text gives the chapter titles, list nesting gives parts.
5. **The next-link chain.** `<link rel="next">` or a "Next chapter" link, followed page by page until it leaves the book's path.
6. **AI fallback.** Send the page's links with a number on each; the AI returns only the numbers of the chapter links, in reading order, the same pattern as item 4's headings.

### The flow

- A pasted page that looks like part of a book (a generator was found, or a contents list or next link exists) shows two buttons: **Add the whole book (24 chapters)** and **Add this page only**.
- The chapter list is fixed before any chapter is fetched, so the member sees the count first.
- Chapters are fetched as a pg-boss job, one at a time, with a small delay, honouring robots.txt, and capped at about 200 pages. Each chapter goes through the normal URL extraction (Readability), which also removes the sidebar, "Previous / Next" and "Edit this page" links.
- The reading's address is the contents page (or the first chapter). Each section keeps its own chapter URL, so the reader can link back to the original.
- A book behind a login (O'Reilly, a course site) uses the extension's "Save this book" mode: it follows the same chapter list in the member's own tab and sends each cleaned page.

### Open questions

- Some web books are still being written. Should a web book be a source (the sources model in `product_vision.md`) that checks for new chapters and adds them?
- When a chapter of the book is already in the library as an article, should the book reuse it (keeping its recall history) or import it again?

## 7. OCR for scanned PDFs

**Status:** future. Scanned PDFs are refused today (item 5). Later, run OCR on pages with no text, in a job, then use item 5's rules. The same OCR can serve camera capture of paper book pages.

## 8. A book made of articles

**Status:** proposed, not built. The case: a book on a site behind a login, one page per chapter, no single-page version and no export. The member reads it chapter by chapter and captures each chapter with the extension as they go.

The member creates the book; the app does not guess it. A book is a container with a title (and optionally an author and a cover) that holds articles as its chapters, in order.

### The flow

1. **Create the book once:** in the library (**New book**), or from the extension popup's book picker (**New book…**, type the title, Save).
2. **Capture a chapter:** the extension popup has a **Book** picker. It defaults to the last book this member added to from the same site, so every chapter after the first is one click: **Save**. Picking **No book** saves a plain article.
3. **In the library:** **Add to book** on any article already captured, and **Remove from book**, which turns the chapter back into a plain article.
4. **Order:** chapters are in the order they were added. The member drags to reorder.

### What a chapter is

- A chapter is a normal article reading: item 4's rules apply inside it (author's headings, cut past 2,500 words, AI headings when it has none), and recall and review work exactly as for any article.
- Capturing the same URL again updates that chapter in place; it does not add a second one.
- An article belongs to at most one book.

### What the book adds

- The library shows the book as one item, with its chapters inside, not each chapter on its own.
- Progress is chapters finished out of chapters added: "5 of 8 chapters read". **Finished** on the book is the milestone from the vision.
- **Continue** opens the first unfinished chapter.

### Data

- `books`: id, member, title, author, cover, created.
- `book_chapters`: book id, reading id (unique, so an article is in one book), position.
- Readings stay as they are. Adding to or removing from a book only changes `book_chapters`, so no recall history is lost.

### Pages behind a paywall

The chapters are behind a paywall, so only the member's logged-in browser can open them. That shapes the design:

- **The server never fetches these pages.** The extension sends the cleaned text from the member's tab. There is no "refresh from the original" on the server; to update a chapter, the member captures it again.
- **The extension sends the images too.** The server can't download them without the member's session, and cookies never leave the browser. The extension reads each image in the tab and uploads its bytes with the chapter (the old `image` block's `src` was kept for exactly this).
- **Preview pages are caught.** A page opened while logged out often shows only the first paragraphs and a "Subscribe to read" box. The extension warns before saving when the text is much shorter than expected or ends at a paywall box, so the member does not save a cut-off chapter by mistake.
- **The original link stays.** Each chapter keeps its URL, so **Open original** works for the member when they are logged in.
- **The copy stays private.** The chapter is for this member only and is never shared with other members, as the vision already says for every entry.
