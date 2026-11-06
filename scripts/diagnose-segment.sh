#!/usr/bin/env bash
# Read-only diagnosis of a dynamic segment's open/click rule on the prod host.
#
# Usage (repo root on the server):
#   ./scripts/diagnose-segment.sh <user-email> <segment-name>
#
# Prints: deployed commit, segment definition + cached count, ClickHouse
# event counts for the rule window, whether event contacts / recipients still
# map to existing contacts, and recent audience warnings from the API log.
# Runs only SELECTs (plus a session temp table in Postgres).
set -euo pipefail

EMAIL="${1:?usage: $0 <user-email> <segment-name>}"
SEG_NAME="${2:?usage: $0 <user-email> <segment-name>}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pg() { docker exec -i sendmast-postgres sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' -- "$@"; }
ch() { docker exec -i sendmast-clickhouse sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" "$@"' -- "$@"; }
sq() { printf "%s" "$1" | sed "s/'/''/g"; }

echo "== deployed commit"; git log -1 --format='%h %ad %s' --date=iso || true

ACC=$(pg -tA -c "select au.account_id from users u join account_users au on au.user_id = u.id
                 where lower(u.email) = lower('$(sq "$EMAIL")') limit 1")
[[ -n "$ACC" ]] || { echo "no account for $EMAIL"; exit 1; }
echo "== account $ACC"
pg -c "select count(*) as contacts, count(*) filter (where subscription_status = 'subscribed') as subscribed
       from contacts where account_id = '$ACC'"

SEG=$(pg -tA -c "select id from segments where account_id = '$ACC' and name = '$(sq "$SEG_NAME")'")
[[ -n "$SEG" ]] || { echo "no segment '$SEG_NAME'"; exit 1; }
echo "== segment $SEG"
pg -c "select cached_count, cached_at, updated_at, jsonb_pretty(definition) as definition
       from segments where id = '$SEG'"

RULE=$(pg -tA -F'|' -c "select r->>'event', r->>'op', r->>'lastDays', coalesce(r->>'campaignId','')
       from segments s, jsonb_array_elements(s.definition->'rules') r
       where s.id = '$SEG' and r->>'type' = 'event' limit 1")
if [[ -z "$RULE" ]]; then echo "segment has no open/click rule"; exit 0; fi
IFS='|' read -r EVENT OP DAYS CID <<<"$RULE"
echo "== rule: event=$EVENT op=$OP lastDays=$DAYS campaign=${CID:-any}"
CFILTER=""; [[ -n "$CID" ]] && CFILTER="AND campaign_id = toUUID('$CID')"
WHERE="account_id = toUUID('$ACC') AND event_type = '$EVENT'
       AND event_time >= now() - INTERVAL $DAYS DAY $CFILTER"

echo "== clickhouse: is_bot column present on email_events?"
ch --query "select count() from system.columns where database = 'sendmast' and table = 'email_events' and name = 'is_bot'"

echo "== clickhouse: '$EVENT' events in window (by is_bot / zero contact_id)"
ch --format PrettyCompact --query "
  select is_bot, contact_id = toUUID('00000000-0000-0000-0000-000000000000') as zero_contact,
         count() as events, uniqExact(contact_id) as contacts, uniqExact(recipient_id) as recipients,
         min(event_time) as first, max(event_time) as last
  from sendmast.email_events where $WHERE group by is_bot, zero_contact order by is_bot, zero_contact"

echo "== clickhouse: '$EVENT' events for this account, all time"
ch --format PrettyCompact --query "
  select count() as events, max(event_time) as last from sendmast.email_events
  where account_id = toUUID('$ACC') and event_type = '$EVENT'"

ch --format TSV --query "select distinct toString(contact_id) from sendmast.email_events
  where $WHERE and is_bot = 0 and contact_id != toUUID('00000000-0000-0000-0000-000000000000') limit 500000" >"$TMP/c.tsv"
ch --format TSV --query "select distinct toString(recipient_id) from sendmast.email_events
  where $WHERE and is_bot = 0 limit 500000" >"$TMP/r.tsv"
echo "== event contact_ids: $(wc -l <"$TMP/c.tsv")   event recipient_ids: $(wc -l <"$TMP/r.tsv")"

echo "== do they still map to existing contacts?"
{
  echo "create temp table ec(id uuid); create temp table er(id uuid);"
  echo "copy ec from stdin;"; cat "$TMP/c.tsv"; echo '\.'
  echo "copy er from stdin;"; cat "$TMP/r.tsv"; echo '\.'
  cat <<SQL
select 'event contact_id -> contacts' as check, count(*) as total, count(c.id) as still_exist
  from ec left join contacts c on c.id = ec.id and c.account_id = '$ACC';
select 'recipient_id -> campaign_recipients' as check, count(*) as total, count(cr.id) as found,
       count(c.id) as recipient_contact_exists, count(c2.id) as same_email_contact_exists
  from er
  left join campaign_recipients cr on cr.id = er.id and cr.account_id = '$ACC'
  left join contacts c on c.id = cr.contact_id
  left join contacts c2 on c2.account_id = '$ACC' and c2.email = cr.email;
SQL
} | pg

echo "== API audience warnings (last 72h)"
docker logs --since 72h sendmast-api 2>&1 | grep -E "event evaluation failed|\[audience\]|event constraint" | tail -20 || true
