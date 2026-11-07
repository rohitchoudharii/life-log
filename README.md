# Life Log Club

A learning app built on deliberate practice (*Peak*) and retrieval practice: read a section, take a recall check on exactly what you read, and review it again after 1, 2, and 3 days, then at growing gaps.

## Layout

- `apps/mobile`: Expo app for iOS, Android, and web
- `apps/api`: Hono API, Postgres through Drizzle, background jobs through pg-boss
- `apps/extension`: Chrome extension that captures the page you are looking at
- `packages/core`: content blocks and sectioning, question types, the review scheduler
- `packages/llm`: Anthropic and OpenAI providers (your own key), question generation, the judge, and the tutor

## Run locally

Requires Node 22.13 or newer (Expo refuses older versions), pnpm (`corepack enable`), and Docker.

```bash
pnpm install
pnpm db:up                          # Postgres on localhost:5544
cp apps/api/.env.example apps/api/.env
# fill ENCRYPTION_KEY (openssl rand -base64 32) and OTP_SECRET (openssl rand -hex 32)
pnpm dev:api                        # API on http://localhost:8787, runs migrations on start
pnpm dev:app                        # Expo dev server on http://localhost:8081; press w for web, i for the iOS simulator
```

Add your Anthropic or OpenAI key in **Settings** in the app. Questions, explanations, grading of written answers, and vocabulary all use it.

There is no email provider yet, so sign-in codes are printed in the API log (`[email] to …`).

On a phone, open the dev server with Expo Go. The app calls the API on the same machine that serves the bundle (port 8787), so the phone and the computer must be on the same network. Set `EXPO_PUBLIC_API_URL` to point somewhere else.

## On your phone

Install **Expo Go** from the App Store or Play Store. No Apple Developer account is needed.

1. On the computer, start the database, the API, and the app (`pnpm dev:app`). Keep the API terminal open: sign-in codes appear there.
2. Connect the phone to the same Wi-Fi as the computer. If macOS asks whether Node may accept incoming connections, allow it, because the phone calls the API on port 8787.
3. Scan the QR code in the `pnpm dev:app` terminal: with the Camera app on iPhone, or from Expo Go on Android.
4. If the app says it can't reach the server, open `http://<computer's IP>:8787/health` in the phone's browser. It should show `{"ok":true}`. If it doesn't, the network or the firewall is blocking it. Tunnel mode (`--tunnel`) does not reach the API; set `EXPO_PUBLIC_API_URL` instead.

Then check each of these:

- [ ] **Sign in** with your email and the code from the API log. Close Expo Go completely and reopen it: you are still signed in, because the session is in the Keychain or Keystore.
- [ ] **Safe areas:** nothing hides under the notch, the status bar, or the home indicator, on Today, the reader, and a test.
- [ ] **Reader:** read a section and scroll to the end. The text is readable without zooming, and code blocks scroll sideways.
- [ ] **Focus session:** start one, lock the phone, and wait. A "Focus time is up" notification arrives at the end, after you allow notifications. Use 15 minutes, or cancel and restart to check sooner.
- [ ] **Keyboard:** in the brain dump and in a written answer, the text box and the buttons below it stay above the keyboard while you type. Drag down on the page to close the keyboard.
- [ ] **Manage test:** from a reading's menu, pick sections and tap **Generate quiz**. Leave the screen while it writes; the questions keep coming in.
- [ ] **Test:** pick sections, write the brain dump, answer a few questions with Previous and auto-advance, and see the results with the recall map.
- [ ] **Review:** answer due ideas, then use Retry missed ideas.
- [ ] **Daily reminder:** set a time a few minutes ahead in Settings, and the reminder arrives. Turn notifications off for Expo Go, and the app still works with no reminder.
- [ ] **Dark mode:** switch the phone to dark mode (or Appearance in Settings), and every screen inverts.

## Web pages

**Add → Link** fetches a page on the server and keeps only its article. Turn on **Import the pages it links to** to bring in each linked page as a reading inside this one, in the background; otherwise links stay tappable while you read, and you can import one then. For pages you need to be signed in to see, use the Chrome extension, which sends the page as your browser shows it.

Install the extension:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `apps/extension`.
3. Pin **Life Log Club capture**. Click it on any page, sign in with your email code, pick a bucket, and capture.

If Life Log Club runs somewhere other than `localhost:8787`, change the address under **Settings** in the popup.

## Books and PDFs

**Add → Book or PDF** takes an EPUB or a PDF of up to 50 MB. A PDF link works in **Link**, and an arXiv link uses the paper's HTML version when it has one, which keeps the math as text.

- **EPUB:** chapters come from the table of contents, including books that put many chapters in one file. Chapter pages go through the same conversion as web pages, and the book's own images are re-encoded and stored. Books with DRM are refused.
- **PDF:** headings come from font size and numbering ("3.1 Attention"). Two-column pages are read column by column, headers and page numbers repeated on every page are dropped, and each page start is marked so you can find a passage in the original. Scanned PDFs without text are refused for now.

How captured pages are kept safe:

- **No HTML is stored or shown.** Readability finds the article, and only its text, headings, lists, code, quotes and images become Life Log Club's own blocks.
- **Images are our own copies.** The server downloads each one, checks that it is a raster image, and re-encodes it as WebP, which drops metadata and anything hidden in the file. Life Log Club serves it from `/media/:id` with `nosniff`. SVG is refused. When a site blocks the server, the extension sends the image bytes, and the same checks apply.
- **Server fetches go only to public addresses.** Private, local and cloud-metadata addresses are refused, and every redirect is checked again. Pages are limited to 5 MB and 15 seconds.
- **The web app has a strict Content Security Policy** in `apps/mobile/public/index.html`. Set the real API address there when Life Log Club is hosted.

## Questions

Nothing is written until you ask. Open **Manage test** from a reading (the reader's menu → **More**, or the library), pick sections, and tap **Generate quiz**. It shows about how many questions it will write before it uses your key. Generating again for a section that already has questions replaces them, along with their review history; other sections keep theirs. A test only asks questions that exist, so sections without any are greyed out in the test picker.

Each quiz has two settings, and their defaults are in **Settings → Questions**:

- **How hard:** Quick (key ideas only), Standard (every main idea), or Thorough (as many as possible).
- **Style:** Mixed (the type that fits each idea), Written (explain it, work it out, predict the output, find the error), or Choice (multiple choice and ordering steps, graded without your AI).

## Explain, teach back, and vocabulary

- **Explain this:** long-press a paragraph on a phone, or select text on the web. Your AI explains it as an explanation, an analogy, or a worked example, grounded in the section. Explanations are saved with the reading under **Your explanations**.
- **Teach it back:** pick an idea, from the reader, the library, or the recall map, and explain it. Your AI plays a student who asks up to three follow-ups, then lists the gaps. An idea with gaps comes back for review within ten minutes.
- **Vocabulary** (Review → Vocabulary): terms picked from your readings with the sentence they appear in, plus words you add. Each is spaced like an idea, and its test grows with it: fill it into its sentence, say what it means, then use it in a new sentence.

## Checks

```bash
pnpm typecheck
pnpm test
```

## Adding a question type

Add an entry to `questionTypes` in `packages/core/src/questions.ts` (content schema, response schema, what the client sees before answering, and the grader), then a renderer in `views` in `apps/mobile/src/practice.tsx`. To have the AI write it, add its lint rules to `lintQuestion` in `packages/core/src/quality.ts`, and its shape and guidance to `SHAPES` and `RULES` in `packages/llm/src/generate.ts` (and to `WRITTEN` or `CHOICE`). Run the eval script on the fixtures before shipping a prompt change.

Types today: explain it (`short_answer`), multiple choice, work it out (`worked_problem`), predict the output, find the error, and order the steps. Numbers, outputs, choices and orders are graded in code; written answers by the checklist judge.
