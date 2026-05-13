#!/usr/bin/env bash
# Manual deploy helper. Run on the EC2 box from the repo root:
#
#   ./deploy.sh
#
# Pulls latest from git, rebuilds the three containers, restarts.
# No CI/CD — you SSH in and run this whenever you want to ship.

set -euo pipefail

echo "▸ Pulling latest…"
git fetch --all
git reset --hard origin/main

echo "▸ Rebuilding + restarting containers…"
docker compose up -d --build

echo "▸ Pruning dangling images (frees disk)…"
docker image prune -f

echo "▸ Status:"
docker compose ps

echo
echo "✓ Deployed. Tail logs with:  docker compose logs -f"
