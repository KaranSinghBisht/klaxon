#!/usr/bin/env bash
# Film prep: collector + public tunnel + COLLECTOR_URL, in one command.
#
#   demo/scripts/film-prep.sh          # start everything, print the URL, stay in foreground
#
# Leave this running in its own window — the collector prints the stolen variables in block type,
# so it IS the "before" shot. Ctrl-C tears down both. Rehearsed end to end 2026-09-12.
set -euo pipefail
REPO="${KLAXON_DEMO_REPO:-KaranSinghBisht/klaxon-demo}"
PORT="${PORT:-4000}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cleanup() { echo; echo "tearing down…"; kill "${CF_PID:-}" "${COL_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "starting the collector on :$PORT…"
pnpm --filter @klaxon-demo/collector start & COL_PID=$!
sleep 5

echo "opening a public tunnel…"
CF_LOG="$(mktemp)"
cloudflared tunnel --url "http://localhost:$PORT" > "$CF_LOG" 2>&1 & CF_PID=$!
URL=""
for _ in $(seq 1 20); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 2
done
[ -z "$URL" ] && { echo "no tunnel URL; see $CF_LOG"; exit 1; }

printf '%s' "$URL/collect" | gh secret set COLLECTOR_URL --repo "$REPO"
echo
echo "  collector : http://localhost:$PORT"
echo "  public    : $URL/collect   (COLLECTOR_URL set on $REPO)"
echo
echo "  Film order — the attack revokes the project, so it goes last:"
echo "    1. gh workflow run ordinary.yml    --repo $REPO   # the theft"
echo "    2. gh workflow run deploy.yml      --repo $REPO   # KLAXON releases, treasury deploys"
echo "    3. gh workflow run worm-attack.yml --repo $REPO   # pays, refused, revoked, phone buzzes"
echo "    recover: WALLET_PASS=… pnpm --filter @klaxon/cli dev unrevoke"
echo
wait
