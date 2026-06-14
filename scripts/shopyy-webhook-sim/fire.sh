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
# Store credentials in the ignored .env.local file or override via env vars:
#   BASE_URL=http://localhost:3000 ./fire.sh create
#   KEY=... STORE_ID=... ./fire.sh
#   DRY_RUN=1 ./fire.sh paid  # print the generated request without sending it
#   # Attribution test: inject a real shop_automation_sends.id as sm_mid into
#   # the order's landing_page so the paid event attributes to that flow send.
#   SM_MID=7d328004-c3dc-4958-8be9-371305f6866d ./fire.sh paid
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load local credentials without allowing them to override explicit env vars.
if [[ -f "$SCRIPT_DIR/.env.local" ]]; then
  while IFS='=' read -r name value; do
    case "$name" in
      BASE_URL) [[ -n "${BASE_URL+x}" ]] || BASE_URL="$value" ;;
      KEY)      [[ -n "${KEY+x}" ]] || KEY="$value" ;;
      STORE_ID) [[ -n "${STORE_ID+x}" ]] || STORE_ID="$value" ;;
      SM_MID)   [[ -n "${SM_MID+x}" ]] || SM_MID="$value" ;;
      DRY_RUN)  [[ -n "${DRY_RUN+x}" ]] || DRY_RUN="$value" ;;
    esac
  done < "$SCRIPT_DIR/.env.local"
fi

BASE_URL="${BASE_URL:-https://app.sendmast.com}"
KEY="${KEY:-}"
STORE_ID="${STORE_ID:-}"
SM_MID="${SM_MID:-}"
DRY_RUN="${DRY_RUN:-0}"

PAYLOAD_DIR="$SCRIPT_DIR/payloads"
FIXTURE_DIR="$SCRIPT_DIR/fixtures"
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
  if [[ ! -f "$file" ]]; then file="$FIXTURE_DIR/$event.json"; fi
  if [[ ! -f "$file" ]]; then
    echo "missing payload: add $PAYLOAD_DIR/$event.json or restore $FIXTURE_DIR/$event.json"
    return 1
  fi

  local store_id="${STORE_ID:-$(jq -r '.store_id // empty' "$file")}"
  if [[ -z "$store_id" || "$store_id" == "null" ]]; then
    echo "missing STORE_ID: set it in $SCRIPT_DIR/.env.local or the environment"
    return 1
  fi
  if [[ "$DRY_RUN" != "1" && -z "$KEY" ]]; then
    echo "missing KEY: set it in $SCRIPT_DIR/.env.local or the environment"
    return 1
  fi

  # 12-digit pseudo-random order id, distinct per call
  local new_id="$(date +%s)$(printf '%02d' $((RANDOM % 100)))"
  local order_no="${store_id}-${new_id}"

  # When SM_MID is set, rewrite landing_page so it carries ?sm_mid=<send id>.
  # Attribution reads exactly this param off the order's landing_page.
  local landing="https://example-store.com/checkout?sm_mid=$SM_MID"

  local body
  body="$(jq \
    --argjson sid "$store_id" \
    --arg oid "$new_id" \
    --arg ono "$order_no" \
    --arg mid "$SM_MID" \
    --arg lp "$landing" '
      .store_id = $sid
      | .id = ($oid | tonumber)
      | .order_number = $ono
      | (if $mid != "" then .landing_page = $lp else . end)
      | (if (.products | type) == "array" then .products |= map(.order_id = ($oid | tonumber) | .store_id = $sid) else . end)
      | (if (.shipping_zone_plans | type) == "array" then .shipping_zone_plans |= map(.order_id = ($oid | tonumber) | .store_id = $sid) else . end)
      | (if (.fulfillment_products | type) == "array" then .fulfillment_products |= map(.order_id = ($oid | tonumber) | .store_id = $sid) else . end)
    ' "$file")"

  local url="$ENDPOINT?key=$KEY&topic=$topic"
  echo "==> $event  topic=$topic  store_id=$store_id  id=$new_id"
  echo "    payload=$file"
  [[ -n "$SM_MID" ]] && echo "    sm_mid=$SM_MID  landing_page=$landing"
  echo "    POST $ENDPOINT?key=<redacted>&topic=$topic"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "$body" | jq .
    echo
    return
  fi
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
