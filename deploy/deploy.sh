#!/usr/bin/env bash
# Copies this checkout to the server and rebuilds the containers there. The server keeps its own
# deploy/.env, which this never overwrites. Migrations run when the API starts.
#
#   deploy/deploy.sh ubuntu@lifelog.club
#
# Set SSH_KEY to the key file if it is not in your SSH config.
set -euo pipefail
host=${1:?Usage: deploy/deploy.sh user@host}
ssh_cmd="ssh${SSH_KEY:+ -i $SSH_KEY}"
cd "$(dirname "$0")/.."

rsync -az --delete -e "$ssh_cmd" \
	--exclude node_modules --exclude dist --exclude .git --exclude .amp --exclude .claude \
	--exclude test-results --exclude playwright-report --exclude .env --exclude .DS_Store \
	./ "$host:life-log/"

$ssh_cmd "$host" 'cd life-log && docker compose -f deploy/compose.yml up -d --build --remove-orphans && docker image prune -f >/dev/null'
