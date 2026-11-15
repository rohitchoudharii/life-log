# Deploying Life Log Club

Production is one Amazon Lightsail server (Ubuntu 24.04, 2 GB, in Sydney, `ap-southeast-2`) running three containers with Docker Compose:

- `db`: Postgres 17. All data lives here, including uploaded books and images.
- `api`: the server, on port 8787 inside Docker only.
- `web`: Caddy. It serves the built web app, passes `/rpc`, `/media` and `/health` to the API, and gets the HTTPS certificate for the domain by itself.

Only Caddy is reachable from outside, on ports 80 and 443.

## The server

- At least 2 GB of memory (the $12 Lightsail plan), because OCR and PDF imports use a lot. Add 2 GB of swap so a build or a large import can't run out.
- 20 GB or more of disk.
- A static IP, so the address stays the same when the instance restarts. It is `52.65.175.188`.
- A firewall that allows 22 (SSH), 80 and 443 (TCP).
- Docker with the Compose plugin, and `rsync`.

## DNS

The domain is at GoDaddy. The `A` record for `@` points at the static IP, and `www` is a `CNAME` to `lifelog.club`. Caddy can only get the certificate once these resolve to the server.

## First deploy

1. On the server, make `~/life-log/deploy/.env` from [`.env.example`](.env.example) and fill it in. Keep a copy of `ENCRYPTION_KEY` somewhere safe, away from the server.
2. From your computer, at the repository root:

   ```bash
   SSH_KEY=~/.ssh/life-log-lightsail.pem deploy/deploy.sh ubuntu@lifelog.club
   ```

3. Invite the first member:

   ```bash
   ssh -i ~/.ssh/life-log-lightsail.pem ubuntu@lifelog.club 'cd life-log && docker compose -f deploy/compose.yml exec -T api pnpm --silent --filter @life-log-club/server invite you@example.com'
   ```

## Later deploys

From the repository root, `pnpm deploy:prod` runs `deploy/deploy.sh` with the key and the static IP. `pnpm logs:prod` shows recent logs, and `pnpm invite:prod someone@example.com` makes an invite.

The deploy script copies the checkout, rebuilds the images on the server and restarts what changed. Migrations run when the API starts.

## Logs and checks

```bash
ssh -i ~/.ssh/life-log-lightsail.pem ubuntu@lifelog.club 'cd life-log && docker compose -f deploy/compose.yml logs -f api'
curl https://lifelog.club/health
```
