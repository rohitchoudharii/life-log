# The production images. deploy/compose.yml builds both targets: `api` (the server) and `web`
# (Caddy with the built web app). See deploy/README.md.

FROM node:26-slim AS build
RUN npm install -g pnpm@12.16.1
WORKDIR /app
COPY . .
# Only the server, the web app and the packages they use; the e2e tests and the extension stay out.
RUN pnpm install --frozen-lockfile --filter '@life-log-club/server...' --filter '@life-log-club/web...'
RUN pnpm --filter @life-log-club/web build

FROM build AS api
ENV NODE_ENV=production
EXPOSE 8787
CMD ["pnpm", "--filter", "@life-log-club/server", "start"]

FROM caddy:2 AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
