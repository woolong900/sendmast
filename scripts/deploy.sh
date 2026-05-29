#!/usr/bin/env bash
# SendMast deploy — single-host, single-command.
#
# Usage (on the Ubuntu server, in the repo root):
#   ./scripts/deploy.sh                # pull, build, migrate, restart
#   ./scripts/deploy.sh --no-pull      # skip git pull (build from local tree)
#   ./scripts/deploy.sh --logs         # tail logs after deploy
#
# Idempotent. Safe to run repeatedly. Uses docker compose's rolling
# `up -d` which only recreates containers whose image changed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE=".env.production"
COMPOSE_FILE="docker/docker-compose.prod.yml"

PULL=1
TAIL_LOGS=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --logs)    TAIL_LOGS=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "✗ $ENV_FILE missing. Copy .env.production.example, fill in secrets, and chmod 600." >&2
  exit 1
fi

# Refuse to run if the env file is world-readable — it contains DB / JWT /
# tracking secrets in plaintext.
perms=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%A' "$ENV_FILE")
if [[ "$perms" != "600" && "$perms" != "400" ]]; then
  echo "✗ $ENV_FILE has insecure perms ($perms). Run: chmod 600 $ENV_FILE" >&2
  exit 1
fi

dc()       { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
dc_mig()   { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile migrate "$@"; }

echo "▶ Deploying SendMast"
echo "  repo:      $ROOT"
echo "  env file:  $ENV_FILE"
echo "  compose:   $COMPOSE_FILE"
echo

if (( PULL )); then
  echo "▶ git pull"
  git pull --ff-only
fi

# Bind-mount sources must exist before `docker compose up` or it errors with
# "no such file or directory". This list is the canonical set — keep in sync
# with `docker/docker-compose.prod.yml`.
DATA_ROOT="${DATA_ROOT:-/var/lib/sendmast}"
for d in caddy-data caddy-config caddy-certs caddy-tracking.d; do
  mkdir -p "$DATA_ROOT/$d"
done

# Build with BuildKit so the multi-stage Dockerfile's deps cache works.
echo "▶ docker compose build"
DOCKER_BUILDKIT=1 dc_mig build --pull

# Bring up data services first; migrations need them healthy.
echo "▶ Starting data services"
dc up -d postgres redis clickhouse minio minio-init

echo "▶ Waiting for Postgres + ClickHouse health"
for svc in sendmast-postgres sendmast-clickhouse; do
  for _ in {1..60}; do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$svc" 2>/dev/null || echo "starting")
    [[ "$status" == "healthy" ]] && break
    sleep 1
  done
  if [[ "${status:-}" != "healthy" ]]; then
    echo "✗ $svc not healthy after 60s; aborting." >&2
    exit 1
  fi
done

# Run migrations via the dedicated `migrator` image (has Prisma CLI + tsx).
# `--rm` cleans the container after. Failure aborts the deploy before any
# new app containers get traffic.
echo "▶ Running database migrations"
dc_mig run --rm migrator

# Now (and only now) flip app traffic. docker compose only recreates
# containers whose image hash changed → unaffected services keep running.
echo "▶ Starting application services (rolling)"
dc up -d caddy api worker-sender worker-events worker-import worker-thumbnail

echo "▶ Pruning old images"
docker image prune -f --filter "until=168h" >/dev/null

echo
echo "✓ Deploy complete."
dc ps

if (( TAIL_LOGS )); then
  echo
  echo "▶ Tailing logs (Ctrl+C to stop)"
  dc logs -f --tail=50
fi
