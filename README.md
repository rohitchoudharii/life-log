# Life Log Club

<img src="apps/mobile/assets/logo.png" alt="Life Log Club logo: a swallow in flight" width="240" />

Life Log Club makes sure you don't forget what life teaches you, and lets you look back at how far you've come. See [product_vision.md](product_vision.md) for the whole product. [docs/guide.md](docs/guide.md) walks through every member flow, with diagrams.

## Layout

- `apps/server`: the API. Hono and oRPC on Node, Postgres through Drizzle, background jobs on pg-boss.
- `apps/web`: the web app. React, Vite, TanStack Router and Query, Tailwind CSS.
- `packages/contract`: the typed API contract that every client uses.
- `packages/domain`: product rules shared by the server and the clients: entry types and the review schedule.
- `packages/llm`: the Anthropic and OpenAI providers, used with each member's own key.
- `apps/extension`: the Chrome extension, built with WXT, that saves the page in the current tab.
- `apps/mobile/assets`: brand assets for the phone app, which comes later.
- `e2e`: end-to-end tests with Playwright.
- `deploy`: the production setup (Docker Compose, Caddy, the deploy script).
- `docs/guide.md`: every member flow, with diagrams.

## Run it on your computer

You need Docker and Node 26 (`nvm install 26`, then `nvm use` in this folder) with pnpm (`npm install -g pnpm`).

The first time only, copy the two settings files and fill them in:

```bash
cp .env.example .env
cp apps/server/.env.example apps/server/.env
```

- In `.env`, set `POSTGRES_PASSWORD` to a new password from `openssl rand -hex 24`.
- In `apps/server/.env`, put that same password in `DATABASE_OWNER_URL`, a second new password in `DATABASE_URL`, and set `ENCRYPTION_KEY` with `openssl rand -base64 32`. Keep a copy of the key somewhere safe: notes about people are encrypted with it and can't be read without it.

Then:

```bash
pnpm install
pnpm db:up   # Postgres in Docker, on localhost:5544 only
pnpm dev     # API on :8787, web app on http://localhost:5173
```

The database has two accounts. `lifelog_owner` owns the tables and runs migrations. `lifelog_app` is the account the API uses, so row-level security applies to every request. The API creates the `lifelog_app` account and sets its password from `DATABASE_URL` on every start, so to change that password, edit `DATABASE_URL` and restart.

## Production

The app runs at https://lifelog.club on one Amazon Lightsail server with Docker Compose: Postgres, the API, and Caddy for HTTPS. [deploy/README.md](deploy/README.md) covers the server, DNS and the deploy script.

```bash
pnpm typecheck                         # a broken build stops the deploy; the old version keeps running
pnpm deploy:prod                       # copies this working tree to the server, rebuilds and restarts (2 to 4 minutes)
pnpm logs:prod                         # the last 100 log lines; add `api` for the API only
pnpm invite:prod someone@example.com   # an invite link for the live app
pnpm extension:prod                    # the Chrome extension for the live app
```

`pnpm deploy:prod` sends the files on disk, not what is committed, so check `git status` first. Migrations run when the API starts, and a deploy keeps the data. The scripts reach the server with the key `~/.ssh/life-log-lightsail.pem`.

## Screens

- **Home** is the hub: one card per pillar with its latest numbers, and the recent entries from every pillar. The Mind card shows how many ideas are due for review.
- Each pillar is its own world: **Mind** is a reading room, **Body** a training log and **Heart** a journal. **Path** is coming later.
- Mind also holds **Review**, **Ideas**, **Words**, **Skills** and **Progress**.
- **+ Log** opens one dialog for every type. It fills in the last values you used, so a repeat log is one click on Save.
- Removing an entry or a reading shows **Undo** for a few seconds.
- On a wide screen the sidebar folds to its icons, and stays folded in that browser.
- Shortcuts: `L` opens the log, `1`–`4` switch between Home and the worlds, `Esc` closes the dialog.

## Data

Every log is an **entry**: a time, a type, its details, and optional text. Each type belongs to one pillar: Lesson, Practice and Finished reading to Mind; Gym set, Meal and Sleep to Body; Mood, Meeting and Moment to Heart. The types and their details live in `packages/domain/src/entries.ts`.

- Each member sees only their own data. Postgres row-level security enforces this on every table, not only the API code.
- Meeting notes (text about other people), recall brain dumps and AI keys are encrypted with AES-256-GCM before they are stored.
- A removed entry can be restored for 30 days; a nightly job then deletes it for good.

## Readings

**Add a reading** on Mind takes a link, pasted text or Markdown, or a file. A new member starts with a sample reading, *How to remember what you read*, which runs the whole loop without an AI key. **Reading now** lists the reading opened last first; one never opened sorts by when it was added. **Finish by**, **Add to book** and **Remove** are under **More** on each row, and Remove asks first.

For a link, the reading shows at once as "Importing…", while a background job fetches the page, finds its article with Mozilla Readability, and splits it into sections at the author's headings. A section past about 2,500 words is cut at a paragraph. The code is in `apps/server/src/import/`.

- The server fetches only public web pages. It refuses private and local addresses, checked again on every redirect and when it connects, and pages over 5 MB.
- The same link added twice is one reading, and so are two links to the same page.
- A page behind a sign-in fails with a message. The Chrome extension saves those (below).
- **Add a file** (or drop one on Mind) adds an EPUB or PDF of up to 25 MB. The file is kept, its images are stored as WebP and shown only to the member who added it, and it is read in a worker thread so a large book can't stall the server. DRM-protected books are refused with a message. A scanned PDF with no text is read with OCR (Tesseract, English, on the server), and the card counts its pages as they are read; scans over 400 pages are refused with a message to split them. A link to a PDF is read the same way.
- A book is split by its own outline: the EPUB table of contents or the PDF bookmarks, up to three levels, with a part page kept as the parent of its chapters. A PDF without bookmarks is split at its headings, and one with neither reads as an article. Front and back matter is recognised from the book's EPUB semantics, then by title (`import/matter.ts`): the cover, copyright, contents, index and similar pages are left out, and a bibliography is kept to read as a reference, with no recall.
- A book's footnotes and endnotes open in a popup from their marker in the text, and are never part of the text a section is recalled from. In an EPUB, a note link is one the book marks as a note, or a short superscript label that points at a footnote, an aside or a notes file. In a PDF, it is a small raised number with a footnote of the same number in the small lines at the foot of its page.
- A link to the contents page of a book with one page per chapter adds the whole book (`import/web-book.ts`). It knows the lists that mdBook, Sphinx and O'Reilly's HTMLBook write, and a list a site labels as its contents. Each chapter page becomes a section, fetched one at a time with a pause between them, in batches of 20, and the card counts the pages as they come. Life Log Club obeys the site's robots.txt and refuses a book longer than 200 pages. A page that can't be added is kept as a short reference section that says why and links to it. **Open original** opens the page a section came from.
- A link to one chapter of such a book adds that chapter as an article. Its card names the book ("Part of *The Rust Programming Language* · 111 pages") with **Add the whole book**, which turns the chapter into the book. The book is found through the chapter's Up or Contents link, two links up at most. A chapter of a book the member already has opens that book.
- **New book** on Mind makes a book from articles, such as a book behind a login with one page per chapter. **Add to book** on an article from a link puts it in a book (a book can't hold a file or another book). A book shows on Mind as one card, with "2 of 5 chapters read" and **Continue**, which opens the first chapter not read. On the book's page the chapters are dragged, or moved with the arrows, into order, and **Remove from book** makes a chapter an article again. A reading counts as read when the end of its last section comes into view.
- **New book** on Mind and **Add to book** also take pages the Chrome extension saved.
- A long article with no headings of its own gets headings from the member's AI key. The AI only says where headings go; the text never changes. A long book chapter with none is cut by length at import, and gets its AI headings when the member first opens it, so a book costs AI calls only for the chapters that are read.
- Import tests use saved real pages and books in `apps/server/src/import/fixtures/`. The e2e tests fetch from a local test site (`e2e/fake-site.ts`).

## Reading and recall

- The reader opens where the member stopped, to the paragraph. **Reading settings** sets text size, line spacing and typeface, and one reading aid at a time: Focus line, Pacer, Phrases, Read aloud or Drift check (`apps/web/src/focus.tsx`). On a wide screen the contents fold away. Every choice is kept in that browser.
- Selected text can be saved as an idea, explained from first principles, or added as a word.
- When a section is read, the member's AI writes its key ideas and questions in the background. At the end of a section (or a chapter), **Recall** asks for a brain dump from memory, grades it against the key ideas, then asks questions: multiple choice, worked problems, predicted output, find the error, put the steps in order, and more.
- **Finished** logs the reading as a milestone and asks for up to 3 key lessons.

## Chrome extension

The extension saves the page in the current tab, for pages the server can't open, such as a book on a site behind a login. Click its button, pick the book (it starts on the last book you added to from the same site, or **No book**, or **New book…**), and **Save**.

- It uses your Life Log Club session in the same browser: sign in to the web app first. Chrome sends the app's cookie with the extension's requests because the extension has access to the app's site. Your cookies for other sites never leave the browser.
- The tab sends the page as you see it and the bytes of its images. The server reads the article with the same code as a pasted link, and fetches only the images the tab couldn't read (a site that blocks other sites from reading them).
- Saving the same page again replaces it and marks it not read.
- Before Save, the popup warns when the page looks like a preview: it stops at a subscribe box, or it is much shorter than the page says, than the book's chapters usually are, or than the copy you saved.

Build it for your app's address, then load `apps/extension/dist/chrome-mv3` in `chrome://extensions` with **Developer mode** on and **Load unpacked**:

```bash
WXT_APP_ORIGIN=http://localhost:5173 pnpm --filter @life-log-club/extension build
```

For the live app, `pnpm extension:prod` builds it for https://lifelog.club into `apps/extension/dist/prod/chrome-mv3`, so both builds can be loaded at once.

## Review

Key ideas from readings, lessons, saved ideas, words and skill practice are **cards** in one review queue. Review asks the card most likely forgotten first, one at a time, with the result after each answer.

- A card goes through three steps, back after 1, 2 and 3 days, then to FSRS, which sets gaps from how memory fades, up to a year. A miss brings it back in 10 minutes and starts the steps again. The rules are in `packages/domain/src/scheduler.ts`.
- The member chooses how well to remember (80% to 95%, 90% by default) in **Settings → Review**.
- Once a month, after 1,000 answers, the schedule is fitted to the member's own memory, and kept only when it predicts better (`apps/server/src/learning/tune.ts`).
- **Teach it back** lets the member explain a missed idea to a curious AI student.
- **Progress** shows recall by week and by gap, how well the schedule predicts recall, calibration, and time read and practised.

## AI key

Each member adds their own Anthropic or OpenAI key in **Settings**. The app checks it by listing the key's models, which costs nothing, picks a low-cost model, and stores the key encrypted. A monthly budget in Settings stops background AI (such as key ideas and fresh questions), never AI the member is waiting for. The e2e tests use a local fake provider (`e2e/fake-llm.ts`), so they never need a real key.

## Members

Life Log Club is invite only. To add someone, or to give a member a new password:

```bash
pnpm invite someone@example.com
```

For the live app, use `pnpm invite:prod someone@example.com`. This prints a link that is valid for 7 days and works once. Send it only to that person. Setting a password signs out every device that used the old one.

Members stay signed in while they use a device. A device that is not used for 30 days must sign in again. **Devices** lists every signed-in device and can sign out a lost one. Five wrong passwords for one email, or twenty from one address, lock sign-in for 15 minutes.

## Checks

```bash
pnpm typecheck
pnpm test        # unit and integration tests
pnpm e2e         # end-to-end tests in a browser, on desktop and phone sizes
```

`pnpm e2e` starts its own API and web app on ports 8788 and 5174, with a separate `lifelog_e2e` database. The `extension` project builds the extension for them and loads it into its own Chromium. Run `pnpm exec playwright install chromium` once before the first run.
