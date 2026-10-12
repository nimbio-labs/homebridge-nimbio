#!/usr/bin/env bash
# Boot a real Homebridge with the built plugin against the Nimbio dev API and
# check what it exposes for a given key type.
#
#   scripts/dev-smoke.sh member  [KEY_FILE]
#   scripts/dev-smoke.sh manager [KEY_FILE]
#
# KEY_FILE defaults to the nimbioCore dev fixtures
# (../nimbioCore/.dev-secrets/e2e-member-account-key / e2e-community-key).
# Refuses live keys: a smoke must never be able to move a real gate.
#
# Asserts, from the log and the cached accessories Homebridge writes:
#   member  — the session line says open-only; only garage doors are cached;
#             no hold-open switches; the event stream was never opened.
#   manager — the session line names a community manager key; at least one
#             gate is cached; hold-open switches exist iff the key has the
#             hold_opens capability; the event stream connected.
set -euo pipefail

MODE="${1:-}"
case "$MODE" in member|manager) ;; *) echo "usage: $0 member|manager [KEY_FILE]" >&2; exit 2;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS="$ROOT/../nimbioCore/.dev-secrets"
DEFAULT_KEY="$SECRETS/e2e-member-account-key"
[ "$MODE" = manager ] && DEFAULT_KEY="$SECRETS/e2e-community-key"
KEY_FILE="${2:-$DEFAULT_KEY}"
[ -r "$KEY_FILE" ] || { echo "key file not readable: $KEY_FILE" >&2; exit 2; }
API_KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
case "$API_KEY" in nimbio_test_*) ;; *) echo "refusing: $KEY_FILE is not a nimbio_test_ key" >&2; exit 2;; esac

RUN_SECONDS="${RUN_SECONDS:-25}"
HB="$ROOT/.hb-dev/$MODE"
rm -rf "$HB"
mkdir -p "$HB/plugins/@nimbio"
ln -s "$ROOT" "$HB/plugins/@nimbio/homebridge-nimbio"

(cd "$ROOT" && npm run --silent build)

# Random bridge identity per run so the smoke never collides with a real bridge.
USERNAME="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n' | sed 's/../&:/g; s/:$//' | tr a-f A-F)"
PORT=$((52000 + RANDOM % 1000))
cat > "$HB/config.json" <<EOF
{
  "bridge": { "name": "Nimbio Smoke", "username": "$USERNAME", "port": $PORT, "pin": "031-45-154" },
  "platforms": [
    { "platform": "NimbioGates", "name": "Nimbio", "apiKey": "$API_KEY", "environment": "dev" }
  ]
}
EOF
chmod 600 "$HB/config.json"

LOG="$HB/homebridge.log"
set +e
timeout --signal=INT "$RUN_SECONDS" "$ROOT/node_modules/.bin/homebridge" \
  -I -D -U "$HB" -P "$HB/plugins" --strict-plugin-resolution > "$LOG" 2>&1
set -e
# The key must never reach the log.
if grep -qF "$API_KEY" "$LOG"; then echo "FAIL: API key appears in the Homebridge log" >&2; exit 1; fi

CACHE="$HB/accessories/cachedAccessories"
fail() { echo "FAIL ($MODE): $*" >&2; echo "--- log: $LOG" >&2; grep -i nimbio "$LOG" | tail -30 >&2; exit 1; }
[ -s "$CACHE" ] || fail "no cached accessories written"

# Summarise the cache: one "role<TAB>name" line per accessory.
SUMMARY="$(node -e '
  const acc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const a of acc) console.log(`${a.context?.role}\t${a.displayName}`);
' "$CACHE")"
echo "Cached accessories ($MODE):"; echo "$SUMMARY" | sed 's/^/  /'

count() { printf '%s\n' "$SUMMARY" | awk -F'\t' -v r="$1" '$1==r' | wc -l; }
GATES=$(( $(count gate) + $(count lock) ))
HOLDS=$(count holdOpen)
[ "$GATES" -gt 0 ] || fail "no gates cached"

if [ "$MODE" = member ]; then
  grep -q "Connected with a member key" "$LOG" || fail "member session line missing"
  [ "$(count lock)" -eq 0 ] || fail "member key exposed a lock"
  [ "$HOLDS" -eq 0 ] || fail "member key exposed hold-open switches"
  grep -q "event stream" "$LOG" && fail "member key opened the event stream"
else
  grep -q "Connected with a community manager key" "$LOG" || fail "manager session line missing"
  grep -q "listening on the Nimbio event stream\|Polling every" "$LOG" || fail "no live updates started"
  grep -q "Event stream unavailable\|Event stream refused" "$LOG" && fail "event stream was refused"
  if grep -q "hold-opens\." "$LOG"; then
    [ "$HOLDS" -gt 0 ] || fail "key has hold_opens but no switches were cached"
  else
    [ "$HOLDS" -eq 0 ] || fail "hold-open switches without the capability"
  fi
fi
grep -qi "error" <(grep -i "nimbio" "$LOG") && { echo "note: error lines mentioning Nimbio:"; grep -i nimbio "$LOG" | grep -i error | head -5; }
echo "PASS ($MODE): $GATES gate(s), $HOLDS hold-open switch(es)"
