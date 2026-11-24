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
  # Only the database URL leaves the subshell; no other secret reaches compose.
  # shellcheck disable=SC1090
  MARGE_PROD_DATABASE_URL=$(. "$SECRETS_FILE" && printf '%s' "${MARGE_PROD_DATABASE_URL:-}")
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
  # is copied, and the PR reviewer's tables come over empty (no private pull
  # request content). Nothing is written to disk.
  # shellcheck disable=SC2016 # $PROD_URL expands inside the container
  PROD_URL="$MARGE_PROD_DATABASE_URL" compose exec -T -e PROD_URL postgres sh -c '
    set -eo pipefail
    RO="-c default_transaction_read_only=on"
    PGOPTIONS="$RO" pg_dump --format=custom --no-owner --no-acl \
      --exclude-table-data=kv_store --exclude-table-data='"'"'pr_reviewer_*'"'"' \
      --dbname="$PROD_URL" |
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

echo "==> Resetting the PR reviewer's canned GitHub, git cache and LLM outage switch"
compose exec -T server rm -rf /tmp/marge-pr-reviewer-github /tmp/marge-pr-reviewer /tmp/marge-demo-llm-outage

PR_PATH="playola-demo/station-scheduler/pulls/42"
echo "==> Checking the PR reviewer is on (GET /v1/pr-reviewer/$PR_PATH/runs/latest)"
TOKEN=$(curl -fsS -X POST http://localhost:3030/v1/auth/dev-login |
  sed -n 's/.*"margeToken":"\([^"]*\)".*/\1/p')
BODY=$(mktemp)
STATUS=$(curl -sS -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3030/v1/pr-reviewer/$PR_PATH/runs/latest" || true)
if [ "$STATUS" != "200" ]; then
  echo >&2
  echo "ERROR: the PR reviewer answered HTTP $STATUS, not 200:" >&2
  cat "$BODY" >&2
  echo >&2
  echo "The reviewer logs why it is off at startup:" >&2
  compose logs server | grep pr_reviewer >&2 || true
  rm -f "$BODY"
  exit 1
fi
rm -f "$BODY"

echo
echo "Demo environment ready ($DATA_SOURCE)."
echo "Record at: http://localhost:5180/dev-user  (signs in as dev@marge.local)"
echo "PR reviewer: http://localhost:5180/pr-reviewer/$PR_PATH"
echo "  (second user: http://localhost:5180/dev-user?as=second in another browser profile)"
echo "API:       http://localhost:3030"
echo "Postgres:  postgres://postgres:demo@localhost:5433/marge_demo"
