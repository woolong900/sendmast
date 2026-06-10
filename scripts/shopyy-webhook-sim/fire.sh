#!/usr/bin/env bash
#
# Locally fire simulated Shopyy webhook events at the SendMast webhook endpoint.
#
# Each invocation rewrites the canned payload so that:
#   - store_id   -> $STORE_ID (default 52051)
#   - id         -> a fresh random order id (so the worker treats it as a NEW order)
#   - order_number / nested order_id refs are kept consistent with the new id
#
# Usage:
#   ./fire.sh                 # fire all three events (create, paid, fulfilled)
#   ./fire.sh create          # fire only orders/create
#   ./fire.sh paid fulfilled  # fire a subset
#
# Override via env vars:
#   BASE_URL=http://localhost:3000 ./fire.sh create
#   KEY=... STORE_ID=... ./fire.sh
set -euo pipefail

BASE_URL="${BASE_URL:-https://app.sendmast.com}"
KEY="${KEY:-981863c1fdbbc0e25f7261d2517ccc6c9b47c6a15b8b76c1}"
STORE_ID="${STORE_ID:-52051}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD_DIR="$SCRIPT_DIR/payloads"
ENDPOINT="$BASE_URL/api/webhooks/shopyy"

command -v jq >/dev/null   || { echo "jq is required (brew install jq)"; exit 1; }
command -v curl >/dev/null || { echo "curl is required"; exit 1; }

# topic for each event key
topic_for() {
  case "$1" in
    create)    echo "orders/create" ;;
    paid)      echo "orders/paid" ;;
    fulfilled) echo "orders/fulfilled" ;;
    *) echo ""; ;;
  esac
}

fire() {
  local event="$1"
  local topic; topic="$(topic_for "$event")"
  local file="$PAYLOAD_DIR/$event.json"

  if [[ -z "$topic" ]]; then echo "unknown event: $event (use create|paid|fulfilled)"; return 1; fi
  if [[ ! -f "$file" ]]; then echo "missing payload: $file"; return 1; fi

  # 12-digit pseudo-random order id, distinct per call
  local new_id="$(date +%s)$(printf '%02d' $((RANDOM % 100)))"
  local order_no="${STORE_ID}-${new_id}"

  local body
  body="$(jq \
    --argjson sid "$STORE_ID" \
    --arg oid "$new_id" \
    --arg ono "$order_no" '
      .store_id = $sid
      | .id = ($oid | tonumber)
      | .order_number = $ono
      | (if (.products | type) == "array" then .products |= map(.order_id = ($oid | tonumber) | .store_id = $sid) else . end)
      | (if (.shipping_zone_plans | type) == "array" then .shipping_zone_plans |= map(.order_id = ($oid | tonumber) | .store_id = $sid) else . end)
      | (if (.fulfillment_products | type) == "array" then .fulfillment_products |= map(.order_id = ($oid | tonumber) | .store_id = $sid) else . end)
    ' "$file")"

  local url="$ENDPOINT?key=$KEY&topic=$topic"
  echo "==> $event  topic=$topic  store_id=$STORE_ID  id=$new_id"
  echo "    POST $url"
  curl -sS -i -X POST "$url" \
    -H 'Content-Type: application/json' \
    --data-binary "$body"
  echo
  echo
}

events=("$@")
if [[ ${#events[@]} -eq 0 ]]; then
  events=(create paid fulfilled)
fi

for e in "${events[@]}"; do
  fire "$e"
done
