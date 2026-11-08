# Life Log Club

<img src="apps/mobile/assets/logo.png" alt="Life Log Club logo: a swallow in flight" width="240" />

Life Log Club makes sure you don't forget what life teaches you, and lets you look back at how far you've come. See [product_vision.md](product_vision.md) for the whole product.

## Layout

- `apps/server`: the API. Hono and oRPC on Node, Postgres through Drizzle.
- `apps/web`: the web app. React, Vite, TanStack Router and Query, Tailwind CSS.
- `packages/contract`: the typed API contract that every client uses.
- `packages/domain`: product rules shared by the server and the clients: entry types and the review schedule.
- `packages/llm`: the Anthropic and OpenAI providers, used with each member's own key.
- `apps/mobile/assets`, `apps/extension`: brand assets for the phone app and the Chrome extension, which come later.
- `e2e`: end-to-end tests with Playwright.

## Run it on your computer

You need Docker and Node 26 (`nvm install 26`, then `nvm use` in this folder) with pnpm (`npm install -g pnpm`).

```bash
pnpm install
pnpm db:up                                   # Postgres in Docker, on localhost:5544
cp apps/server/.env.example apps/server/.env # first time only, then set ENCRYPTION_KEY
pnpm dev                                     # API on :8787, web app on http://localhost:5173
```

The API creates its database and account on first start. Set `ENCRYPTION_KEY` in `apps/server/.env` with `openssl rand -base64 32`, and keep a copy somewhere safe: notes about people are encrypted with it and can't be read without it.

## Screens

- **Home** is the hub: one card per pillar with its latest numbers, and the recent entries from every pillar.
- Each pillar is its own world: **Mind** is a reading room, **Body** a training log and **Heart** a journal. **Path** is coming later.
- **+ Log** opens one dialog for every type. It fills in the last values you used, so a repeat log is one click on Save.
- Removing an entry shows **Undo** for a few seconds.
- Shortcuts: `L` opens the log, `1`–`4` switch between Home and the worlds, `Esc` closes the dialog.

## Data

Every log is an **entry**: a time, a type (such as a gym set, a meal or a meeting), its details, and optional text. Each type belongs to one pillar. The types and their details live in `packages/domain/src/entries.ts`.

- Each member sees only their own entries. Postgres row-level security enforces this, not only the API code.
- The text of entries about other people (meetings) is encrypted with AES-256-GCM before it is stored.
- A removed entry can be restored for 30 days; a nightly job then deletes it for good.

## Review

Ideas from reading and lessons from life are **cards** in one review queue. A new card is due at once. Remembering it brings it back after 1, 2 and 3 days, then at gaps that grow with how easily you remember it, up to a year. Forgetting it brings it back in 10 minutes and starts the steps again. The rules are in `packages/domain/src/scheduler.ts`.

## AI key

Each member adds their own Anthropic or OpenAI key in **Settings**. The app checks it by listing the key's models, which costs nothing, picks a low-cost model, and stores the key encrypted. The e2e tests use a local fake provider (`e2e/fake-llm.ts`), so they never need a real key.

## Members

Life Log Club is invite only. To add someone, or to give a member a new password:

```bash
pnpm invite someone@example.com
```

This prints a link that is valid for 7 days and works once. Send it only to that person. Setting a password signs out every device that used the old one.

Members stay signed in while they use a device. A device that is not used for 30 days must sign in again. **Devices** lists every signed-in device and can sign out a lost one. Five wrong passwords for one email lock it for 15 minutes.

## Checks

```bash
pnpm typecheck
pnpm test        # unit and integration tests
pnpm e2e         # end-to-end tests in a browser, on desktop and phone sizes
```

`pnpm e2e` starts its own API and web app on ports 8788 and 5174, with a separate `lifelog_e2e` database. Run `pnpm exec playwright install chromium` once before the first run.
