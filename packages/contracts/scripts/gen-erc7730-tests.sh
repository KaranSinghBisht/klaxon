#!/usr/bin/env bash
#
# gen-erc7730-tests.sh — regenerate erc7730/testsv2/calldata-KlaxonRegistry.tests.json.
#
# The `rawTx` values in the test file are full signed transactions whose `to` MUST match one of the
# `context.contract.deployments[].address` entries in the descriptor. Until KlaxonRegistry is
# deployed, both are the zero-address placeholder. After deployment, update the descriptor and then
# re-run this with the real address and chain id:
#
#   REGISTRY=0x… CHAIN_ID=8453 ./scripts/gen-erc7730-tests.sh
#
# Runs fully offline: nonce, gas and chain id are all supplied explicitly, so `cast mktx` never
# reaches for an RPC.

set -euo pipefail

die() {
    echo "gen-erc7730-tests.sh: $*" >&2
    exit 1
}

command -v cast >/dev/null 2>&1 || die "cast not found on PATH (install Foundry: https://getfoundry.sh)"

REGISTRY=${REGISTRY:-0x0000000000000000000000000000000000000000}
CHAIN_ID=${CHAIN_ID:-11155111}

# Anvil / Hardhat account #0. This key is published in Foundry's own documentation and printed by
# `anvil` on every start — it is deliberately public and holds nothing. It is used here only so the
# committed test vectors are byte-for-byte reproducible; ERC-7730 test runners decode calldata and
# never look at the signer.
TEST_KEY=${ERC7730_TEST_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}

[[ $REGISTRY =~ ^0x[0-9a-fA-F]{40}$ ]] || die "REGISTRY must be a 20-byte hex address, got '$REGISTRY'"
[[ $CHAIN_ID =~ ^[1-9][0-9]*$ ]] || die "CHAIN_ID must be a positive integer, got '$CHAIN_ID'"

# Fixed demo values so the vectors stay stable across regenerations.
#   PID    = keccak256("klaxon/KaranSinghBisht/klaxon")
#   POLICY = keccak256("klaxon.policy.json@demo")
PID=$(cast keccak "klaxon/KaranSinghBisht/klaxon")
POLICY=$(cast keccak "klaxon.policy.json@demo")
EPOCH=4

mktx() {
    cast mktx "$REGISTRY" "$@" \
        --private-key "$TEST_KEY" \
        --nonce "$NONCE" \
        --gas-limit 100000 \
        --gas-price 1gwei \
        --priority-gas-price 1gwei \
        --chain "$CHAIN_ID"
}

NONCE=0 && RAW_REGISTER=$(mktx "register(bytes32)" "$PID")
NONCE=1 && RAW_COMMIT=$(mktx "commitPolicy(bytes32,bytes32)" "$PID" "$POLICY")
NONCE=2 && RAW_UNREVOKE=$(mktx "unrevoke(bytes32,uint64)" "$PID" "$EPOCH")

OUT="$(dirname "$0")/../erc7730/testsv2/calldata-KlaxonRegistry.tests.json"
mkdir -p "$(dirname "$OUT")"

cat >"$OUT" <<EOF
{
  "\$schema": "../../../specs/erc7730-tests-v2.schema.json",
  "descriptor": "../calldata-KlaxonRegistry.json",
  "tests": [
    {
      "description": "Claim a KLAXON project",
      "rawTx": "$RAW_REGISTER",
      "expected": {
        "intent": "Claim a KLAXON project",
        "interpolatedIntent": "Claim KLAXON project $PID",
        "owner": "KLAXON",
        "fields": [
          {"label": "Project", "value": "$PID"}
        ]
      }
    },
    {
      "description": "Commit a policy hash",
      "rawTx": "$RAW_COMMIT",
      "expected": {
        "intent": "Commit KLAXON release policy",
        "interpolatedIntent": "Commit policy $POLICY for project $PID",
        "owner": "KLAXON",
        "fields": [
          {"label": "Project", "value": "$PID"},
          {"label": "Policy hash", "value": "$POLICY"}
        ]
      }
    },
    {
      "description": "Lift a revocation by advancing the epoch",
      "rawTx": "$RAW_UNREVOKE",
      "expected": {
        "intent": "Lift KLAXON revocation",
        "interpolatedIntent": "Lift revocation for $PID at epoch $EPOCH",
        "owner": "KLAXON",
        "fields": [
          {"label": "Project", "value": "$PID"},
          {"label": "Epoch", "value": "$EPOCH"}
        ]
      }
    }
  ]
}
EOF

echo "wrote $OUT (registry=$REGISTRY chainId=$CHAIN_ID)"
