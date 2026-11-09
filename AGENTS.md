# Life Log Club

A private, invite-only app that helps a small circle of members remember what life teaches them, across four pillars: Mind, Body, Heart and Path. The README covers setup and what the app does today.

## Read before you change anything

- `product_vision.md`: the whole product. Its principles are rules: logging or reading anything takes one or two clicks, the app fills in smart defaults, and nothing assumes a daily schedule.
- `learning_spec.md`: the spec for the next stage of the Mind pillar (reading, recall, review).
- GitHub issues (`gh issue list -R rohitchoudharii/life-log`): the task list. There is no task file in the repo; plan new work as an issue.
- The app before the rebuild (Peak) has tested code to reuse, such as page extraction, EPUB and PDF import, and AI prompts: `git show 4051df5^:<path>`, for example `git show 4051df5^:apps/api/src/web/extract.ts`.
- `.claude/agents/content-ingestion-engineer.md`: the expert to consult before designing an import path.

## Layout

- `apps/server`: the API. Hono and oRPC on Node, Postgres through Drizzle, background jobs on pg-boss.
- `apps/web`: the web app. React, Vite, TanStack Router and Query, Tailwind CSS.
- `packages/contract`: the typed API contract every client uses.
- `packages/domain`: product rules shared by the server and clients (entry types, the review scheduler).
- `packages/llm`: Anthropic and OpenAI providers, used with each member's own key.
- `e2e`: Playwright tests, run at desktop and phone sizes.
- `apps/mobile/assets`, `apps/extension`: brand assets only. The phone app and the Chrome extension come later.

## Commands

Use Node 26 (`nvm use`) and pnpm. Run from the repo root.

```bash
pnpm db:up       # Postgres in Docker on localhost:5544
pnpm dev         # API on :8787, web app on http://localhost:5173
pnpm typecheck   # every package, plus e2e
pnpm test        # unit and integration tests
pnpm e2e         # Playwright; starts its own API (:8788), web app (:5174) and fake LLM
```

- Server integration tests need Postgres running and `apps/server/.env`; they use a separate `lifelog_test` database. e2e uses `lifelog_e2e`.
- Before the first e2e run: `pnpm exec playwright install chromium`.
- Run one package's tests with `pnpm --filter @life-log-club/server test` (or `domain`, `web`).

## How the server works

- **Contract first.** A new endpoint starts in `packages/contract/src/index.ts`, gets its handler in `apps/server/src/routes/`, and is added to `apps/server/src/router.ts`. Clients only call the API through the contract.
- **Every member's data goes through `asUser(userId, tx => ...)`** from `apps/server/src/db/client.ts`. It runs as the `lifelog_app` account with the member set, so Postgres row-level security decides what the query can see. `ownerDb` bypasses that; use it only for owner work such as migrations and cleanup jobs.
- **A new table that holds member data** gets a `userId` column and a `pgPolicy` in `apps/server/src/db/schema.ts`, like `entries`. Foreign keys skip row-level security, so when a row points at another member-owned row, check that the target belongs to the same member.
- **Text about other people** (for example meeting notes) is encrypted with `encrypt` / `decrypt` from `apps/server/src/crypto.ts`. Entry types mark this with `privateText` in `packages/domain/src/entries.ts`.
- **Migrations:** change `schema.ts`, then run `pnpm --filter @life-log-club/server db:generate`. The server applies migrations on start (`db/prepare.ts`). Never edit a migration that is already committed; add a new one.
- **Writes are idempotent.** Clients choose ids, and creates use `onConflictDoNothing`, so a retried request does not create a second row.
- **AI** always uses the member's own key through `packages/llm`. Tests use the fake provider in `e2e/fake-llm.ts`; no test needs a real key.

## Web app

- Each pillar is its own world. Its colours and type come from `[data-world]` tokens in `apps/web/src/styles.css`; shared components are in `apps/web/src/ui.tsx`. A world changes tokens and layout, not components.
- Keep the shared chrome: the **+ Log** button and the shortcuts (`L` to log, `1` to `4` to switch worlds, `Esc` to close).
- Check a UI change in the browser at desktop and phone widths, not only in code.

## Code style

- TypeScript, tabs, single quotes, no semicolons. There is no formatter config, so match the code around you.
- Comments say why, not what. Doc comments on exported functions describe behaviour in plain sentences.
- Text a member sees is short, plain and calm. Error messages say what happened and what to do next ("This invite link has expired or was already used. Ask for a new one.").
- Call people who use the app **members**.

## Tests

- e2e tests drive the app the way a member does: through labels and roles, at both desktop and phone sizes.
- Test behaviour a member or client can see, not internals. Prefer extending an existing spec to adding a new file.

## Commits

- A subject line in the imperative that says what changed for the product ("Show the invite's email on the welcome page"), then a body in plain prose that says why.
- Never commit `.env` files or real keys. Only the `.env.example` files are tracked.
