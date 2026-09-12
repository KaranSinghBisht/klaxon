#!/usr/bin/env bash
# Ship the locally-built witness image to the EC2 host and restart it.
#
#   deploy/aws/redeploy.sh
#
# Must be run from a terminal that can reach port 22 (the assistant's sandbox cannot).
# Assumes the image is already built and saved to /tmp/klaxon-witness.tgz:
#   docker build --platform linux/arm64 --provenance=false -f packages/witness/Dockerfile -t klaxon-witness:latest .
#   docker save klaxon-witness:latest | gzip > /tmp/klaxon-witness.tgz
set -euo pipefail
HOST="${KLAXON_WITNESS_HOST:-ec2-user@44.198.37.65}"
KEY="${KLAXON_WITNESS_KEY:-$HOME/.ssh/klaxon-witness.pem}"
IMG="${KLAXON_WITNESS_IMAGE:-/tmp/klaxon-witness.tgz}"

# Build unless an image newer than the last witness commit is already packed. Docker Desktop has to
# be running; if it is not, start it and re-run — everything below is idempotent.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NEWEST_SRC="$(cd "$ROOT" && git log -1 --format=%ct -- packages/witness/src packages/core/src 2>/dev/null || echo 0)"
IMG_MTIME="$( [ -f "$IMG" ] && stat -f %m "$IMG" 2>/dev/null || echo 0 )"
if [ "$IMG_MTIME" -lt "$NEWEST_SRC" ]; then
  echo "packed image is older than the latest witness change — rebuilding…"
  docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and re-run."; exit 1; }
  ( cd "$ROOT" && docker build --platform linux/arm64 --provenance=false \
      -f packages/witness/Dockerfile -t klaxon-witness:latest . )
  docker save klaxon-witness:latest | gzip > "$IMG"
else
  echo "packed image is current"
fi
[ -f "$IMG" ] || { echo "no image at $IMG"; exit 1; }
echo "shipping $(du -h "$IMG" | cut -f1) to $HOST …"
scp -i "$KEY" -o StrictHostKeyChecking=accept-new "$IMG" "$HOST:/opt/klaxon/klaxon-witness.tgz"
ssh -i "$KEY" "$HOST" 'cd /opt/klaxon \
  && gunzip -c klaxon-witness.tgz | docker load \
  && docker compose up -d \
  && sleep 6 \
  && docker compose ps'
echo
echo "verifying from the public endpoint…"
curl -s --max-time 15 https://44-198-37-65.sslip.io/health; echo
