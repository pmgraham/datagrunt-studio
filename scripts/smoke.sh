#!/usr/bin/env bash
set -euo pipefail

# Boot the backend, wait for health, run one real query through Datagrunt+DuckDB.
cd "$(dirname "$0")/.."
source backend/.venv/bin/activate
STUDIO_DATA_DIR="$(mktemp -d)" uvicorn app.main:app --app-dir backend --port 8000 &
BACKEND_PID=$!
trap 'kill $BACKEND_PID' EXIT

for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:8000/health >/dev/null; then break; fi
  sleep 0.5
done

echo "Seeding + querying..."
curl -sf -X POST http://127.0.0.1:8000/session/reset >/dev/null
RESULT=$(curl -sf -X POST http://127.0.0.1:8000/query \
  -H 'Content-Type: application/json' \
  -d '{"mode":"sql","sql":"SELECT region_name FROM region_master ORDER BY region_name LIMIT 1"}')
echo "Query result: $RESULT"
echo "$RESULT" | grep -q '"error":null' && echo "SMOKE OK"
