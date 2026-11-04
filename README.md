# Peak

A learning app built on deliberate practice (*Peak*) and retrieval practice: read a section, take a recall check on exactly what you read, and review it again after 1, 2, and 3 days, then at growing gaps.

## Layout

- `apps/mobile`: Expo app for iOS, Android, and web
- `apps/api`: Hono API, Postgres through Drizzle, background jobs through pg-boss
- `packages/core`: content blocks and sectioning, question types, the review scheduler
- `packages/llm`: Anthropic and OpenAI providers (your own key) and question generation

## Run locally

Requires Node 20 or newer (Expo recommends 22.13+), pnpm (`corepack enable`), and Docker.

```bash
pnpm install
pnpm db:up                          # Postgres on localhost:5544
cp apps/api/.env.example apps/api/.env
# fill ENCRYPTION_KEY (openssl rand -base64 32) and OTP_SECRET (openssl rand -hex 32)
pnpm dev:api                        # API on http://localhost:8787, runs migrations on start
pnpm dev:app                        # Expo dev server; press w for web, i for the iOS simulator
```

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
- [ ] **Test:** pick sections, write the brain dump, answer a few questions with Previous and auto-advance, and see the results with the recall map.
- [ ] **Review:** answer due ideas, then use Retry missed ideas.
- [ ] **Daily reminder:** set a time a few minutes ahead in Settings, and the reminder arrives. Turn notifications off for Expo Go, and the app still works with no reminder.
- [ ] **Dark mode:** switch the phone to dark mode (or Appearance in Settings), and every screen inverts.

## Checks

```bash
pnpm typecheck
pnpm test
```

## Adding a question type

Add an entry to `questionTypes` in `packages/core/src/questions.ts` (content schema, response schema, what the client sees before answering, and the grader), then a renderer in `views` in `apps/mobile/src/practice.tsx`.
