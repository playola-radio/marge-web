#!/usr/bin/env bash
# Brings up the local demo environment described in factory/DEMO.md.
# Safe to re-run: each run rebuilds the demo database from scratch.
#
# Data: with MARGE_PROD_DATABASE_URL set, a read-only copy of production;
# otherwise the sample factory push in scripts/demo-seed.json.
set -euo pipefail
cd "$(dirname "$0")/.."

SECRETS_FILE="$HOME/factory/secrets.env"
if [ -z "${MARGE_PROD_DATABASE_URL:-}" ] && [ -f "$SECRETS_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
  set +a
fi

compose() { docker compose -p marge-demo -f docker-compose.demo.yml "$@"; }

echo "==> Starting demo Postgres (localhost:5433)"
compose up -d --wait postgres

echo "==> Recreating database marge_demo"
compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "DROP DATABASE IF EXISTS marge_demo WITH (FORCE)" \
  -c "CREATE DATABASE marge_demo"

if [ -n "${MARGE_PROD_DATABASE_URL:-}" ]; then
  echo "==> Copying production into marge_demo (read-only on production)"
  # Every production command runs in a read-only session. Relay sessions in
  # kv_store (sealed sign-in codes) are left out; only the factory snapshot row
  # is copied. Nothing is written to disk.
  # shellcheck disable=SC2016 # $PROD_URL expands inside the container
  PROD_URL="$MARGE_PROD_DATABASE_URL" compose exec -T -e PROD_URL postgres sh -c '
    set -eo pipefail
    RO="-c default_transaction_read_only=on"
    PGOPTIONS="$RO" pg_dump --format=custom --no-owner --no-acl \
      --exclude-table-data=kv_store --dbname="$PROD_URL" |
      pg_restore --no-owner --no-acl --exit-on-error -U postgres -d marge_demo
    PGOPTIONS="$RO" psql "$PROD_URL" -qAt -v ON_ERROR_STOP=1 \
      -c "COPY (SELECT key, val, expires_at FROM kv_store WHERE key = '"'"'factory:snapshot'"'"') TO STDOUT" |
      psql -q -v ON_ERROR_STOP=1 -U postgres -d marge_demo -c "COPY kv_store FROM STDIN"
  '
  DATA_SOURCE="production copy"
else
  echo "==> MARGE_PROD_DATABASE_URL not set; using sample data"
  DATA_SOURCE="sample data"
fi

echo "==> Building, migrating and starting server + client"
compose up -d --build --wait server client

if [ "$DATA_SOURCE" = "sample data" ]; then
  echo "==> Seeding a sample factory push"
  curl -fsS -X POST http://localhost:3030/v1/factory/sync \
    -H "Authorization: Bearer demo-factory-token" \
    -H "Content-Type: application/json" \
    --data-binary @scripts/demo-seed.json
fi

curl -fsS -o /dev/null http://localhost:3030/v1/healthCheck
curl -fsS -o /dev/null http://localhost:5180/

echo
echo "Demo environment ready ($DATA_SOURCE)."
echo "Record at: http://localhost:5180/dev-user  (signs in as dev@marge.local)"
echo "API:       http://localhost:3030"
echo "Postgres:  postgres://postgres:demo@localhost:5433/marge_demo"
