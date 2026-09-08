#!/usr/bin/env bash
#
# calldata.sh — encode a KlaxonRegistry call for `wallet-cli send --data`.
#
# Wraps `cast calldata` so the CLI and the operator can produce `--data` without Node or viem.
# Prints the 0x-prefixed calldata to stdout and nothing else, so it substitutes directly into the
# device invocation.

set -euo pipefail

die() {
    echo "calldata.sh: $*" >&2
    exit 1
}

usage() {
    cat >&2 <<'EOF'
Usage:
  ./scripts/calldata.sh register      <projectId>
  ./scripts/calldata.sh commit-policy <projectId> <policyHash>
  ./scripts/calldata.sh unrevoke      <projectId> <epoch>

  <projectId>, <policyHash>  0x-prefixed 32-byte hex (66 characters)
  <epoch>                    decimal uint64

Example:
  DATA=$(./scripts/calldata.sh commit-policy "$PID" "$POLICY_HASH")
  wallet-cli send -a "$LABEL" --to "$REGISTRY" --amount "0 ETH" --data "$DATA" \
    --output json --device-timeout 180000
EOF
    exit 2
}

command -v cast >/dev/null 2>&1 || die "cast not found on PATH (install Foundry: https://getfoundry.sh)"

# Reject anything that is not exactly 0x + 64 hex digits before it reaches cast, so a truncated
# shell variable fails here rather than producing a valid-looking transaction for the wrong bytes.
require_bytes32() {
    local name=$1 value=$2
    [[ $value =~ ^0x[0-9a-fA-F]{64}$ ]] ||
        die "$name must be 0x-prefixed 32-byte hex (66 chars), got: '$value'"
}

# uint64 max is 18446744073709551615, which overflows bash's signed 64-bit arithmetic, so the
# bound is checked on the digit string rather than numerically.
require_uint64() {
    local name=$1 value=$2 max=18446744073709551615
    [[ $value =~ ^(0|[1-9][0-9]*)$ ]] || die "$name must be a decimal uint64, got: '$value'"
    if ((${#value} > ${#max})) || { ((${#value} == ${#max})) && [[ $value > $max ]]; }; then
        die "$name exceeds uint64 range, got: '$value'"
    fi
}

[[ $# -ge 1 ]] || usage

case "$1" in
register)
    [[ $# -eq 2 ]] || usage
    require_bytes32 projectId "$2"
    cast calldata "register(bytes32)" "$2"
    ;;
commit-policy | commitPolicy)
    [[ $# -eq 3 ]] || usage
    require_bytes32 projectId "$2"
    require_bytes32 policyHash "$3"
    cast calldata "commitPolicy(bytes32,bytes32)" "$2" "$3"
    ;;
unrevoke)
    [[ $# -eq 3 ]] || usage
    require_bytes32 projectId "$2"
    require_uint64 epoch "$3"
    cast calldata "unrevoke(bytes32,uint64)" "$2" "$3"
    ;;
-h | --help | help)
    usage
    ;;
*)
    die "unknown command '$1' (expected: register, commit-policy, unrevoke)"
    ;;
esac
