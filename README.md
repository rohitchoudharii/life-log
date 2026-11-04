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

## Checks

```bash
pnpm typecheck
pnpm test
```

## Adding a question type

Add an entry to `questionTypes` in `packages/core/src/questions.ts` (content schema, response schema, what the client sees before answering, and the grader), then a renderer in `views` in `apps/mobile/src/practice.tsx`.
