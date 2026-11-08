# Life Log Club

<img src="apps/mobile/assets/logo.png" alt="Life Log Club logo: a swallow in flight" width="240" />

Life Log Club makes sure you don't forget what life teaches you, and lets you look back at how far you've come. See [product_vision.md](product_vision.md) for the whole product.

## Layout

- `apps/server`: the API. Hono and oRPC on Node, Postgres through Drizzle.
- `apps/web`: the web app. React, Vite, TanStack Router and Query, Tailwind CSS.
- `packages/contract`: the typed API contract that every client uses.
- `packages/domain`: product rules shared by the server and the clients.
- `apps/mobile/assets`, `apps/extension`: brand assets for the phone app and the Chrome extension, which come later.
- `e2e`: end-to-end tests with Playwright.

## Run it on your computer

You need Docker and Node 26 (`nvm install 26`, then `nvm use` in this folder) with pnpm (`npm install -g pnpm`).

```bash
pnpm install
pnpm db:up                                   # Postgres in Docker, on localhost:5544
cp apps/server/.env.example apps/server/.env # first time only
pnpm dev                                     # API on :8787, web app on http://localhost:5173
```

The API creates its database and account on first start.

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
