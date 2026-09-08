#!/usr/bin/env bash
# GATE A — prove headless Key Ring decrypt from a clean Linux container holding only KLAXON_MEMBER.
#
#   1. On the laptop, once, with the device:   wallet-cli ring init --name "klaxon:laptop" --output json
#   2. Then:                                    WALLET_PASS=… pnpm --filter @klaxon/cli dev export-member > /tmp/member.b64
#   3. Then:                                    scripts/gate-a.sh /tmp/member.b64
#
# The script encrypts a random 32-byte blob on the laptop with core's ringEncrypt (which must match
# `wallet-cli ring encrypt`), ships ONLY the ciphertext + KLAXON_MEMBER into node:24-bookworm-slim,
# restores the trustchain over the network (no device, no keychain) and decrypts it there.
set -euo pipefail
MEMBER_FILE="${1:?usage: scripts/gate-a.sh <file containing the export-member line>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
pnpm --filter @klaxon/core build >/dev/null
KEYNAME="klaxon/gate-a/$(date +%s)"
node --input-type=module -e "
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { decodeMember, restoreWalletSyncKey, ringEncrypt } from './packages/core/dist/index.js';
const member = decodeMember(process.env.MEMBER);
const wsek = await restoreWalletSyncKey(member);           // laptop side: also network-only
const pt = randomBytes(32);
writeFileSync('/tmp/gate-a.pt', pt);
writeFileSync('/tmp/gate-a.ct', ringEncrypt(wsek, process.env.KEYNAME, pt));
console.log('laptop: encrypted 32 bytes under', process.env.KEYNAME);
" MEMBER="$(cat "$MEMBER_FILE")" KEYNAME="$KEYNAME"
echo "container: restoring + decrypting with ONLY KLAXON_MEMBER…"
docker run --rm \
  -e MEMBER="$(cat "$MEMBER_FILE")" -e KEYNAME="$KEYNAME" \
  -v "$ROOT/packages/core/dist:/core:ro" -v "$ROOT/node_modules:/node_modules:ro" \
  -v /tmp/gate-a.ct:/gate-a.ct:ro -v /tmp/gate-a.pt:/gate-a.pt:ro \
  node:24-bookworm-slim node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { decodeMember, restoreWalletSyncKey, ringDecrypt } from '/core/index.js';
const wsek = await restoreWalletSyncKey(decodeMember(process.env.MEMBER));
const pt = ringDecrypt(wsek, process.env.KEYNAME, readFileSync('/gate-a.ct'));
if (!pt.equals(readFileSync('/gate-a.pt'))) { console.error('GATE A FAILED: plaintext mismatch'); process.exit(1); }
console.log('GATE A PASSED: headless restore + ringDecrypt in a clean container');
"
# Cross-check with the real Ledger CLI on the laptop (the interop proof):
echo "laptop: real wallet-cli ring decrypt of the same blob…"
wallet-cli ring decrypt --key "$KEYNAME" -i /tmp/gate-a.ct -o /tmp/gate-a.cli.pt --output json >/dev/null
cmp /tmp/gate-a.pt /tmp/gate-a.cli.pt && echo "INTEROP PASSED: wallet-cli opened core's ciphertext"
rm -f /tmp/gate-a.pt /tmp/gate-a.ct /tmp/gate-a.cli.pt
