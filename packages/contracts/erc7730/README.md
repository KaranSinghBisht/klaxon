# ERC-7730 clear-signing descriptor — `KlaxonRegistry`

These two files are staged here and copied into a fork of
[`LedgerHQ/clear-signing-erc7730-registry`](https://github.com/LedgerHQ/clear-signing-erc7730-registry)
when the PR is opened:

| here | there |
| --- | --- |
| `calldata-KlaxonRegistry.json` | `registry/klaxon/calldata-KlaxonRegistry.json` |
| `testsv2/calldata-KlaxonRegistry.tests.json` | `registry/klaxon/testsv2/calldata-KlaxonRegistry.tests.json` |

The `$schema` paths (`../../specs/…` and `../../../specs/…`) are relative to those destinations,
not to this directory, so they only resolve once the files are in the fork.

## TODO before opening the PR

- [ ] **Replace the placeholder addresses.** Both `context.contract.deployments[].address` entries
      are `0x0000000000000000000000000000000000000000`. Fill in the real deployed addresses.
- [ ] **Regenerate the test vectors for the real address.** The `rawTx` values are signed
      transactions whose `to` must match a deployment address, so they are placeholders too:

      REGISTRY=0x<deployed> CHAIN_ID=8453 ../scripts/gen-erc7730-tests.sh

- [ ] **Decide whether the Sepolia deployment stays.** See below.
- [ ] **Fix `metadata.info.deploymentDate`** to the real deployment timestamp (currently
      `2026-09-09T00:00:00Z`).
- [ ] **Verify on Sourcify** as well as Basescan — reviewers are told to ask for it.
- [ ] Validate against `specs/erc7730-v2.schema.json` before pushing (see the root README).

## The chainId question (build plan B, C8 / ruling D13)

The descriptor currently lists **both** chain ids:

| chainId | network | why |
| --- | --- | --- |
| 8453 | Base mainnet | the deployment that makes the PR mergeable |
| 11155111 | Sepolia | the deployment the demo actually signs against |

**Recommendation: drop the Sepolia entry before opening the PR.** No descriptor in the registry
targets a testnet. The CI linter fetches a reference ABI per deployment; for an unverified testnet
address it silently skips field validation and warns, and reviewers are instructed to ask for a
Sourcify verification. A Sepolia entry is at best un-reviewable and at worst a rejection.

Keeping it costs nothing locally, so it stays here as a placeholder until the deployment addresses
are known — but the mergeable PR is the Base-mainnet-only one. Dropping it is one edit plus one
command (`CHAIN_ID=8453 ../scripts/gen-erc7730-tests.sh`).

Note that this does **not** change the demo: a descriptor is keyed by `chainId + address`, so a
Base descriptor never clear-signs a Sepolia call. The Sepolia calls in the video blind-sign either
way, which is the point of the on-camera line — *"blind signing, because the descriptor for this
deployment isn't merged yet; here's the PR."*

## What the reviewer checks

CI enforces schema, file naming, index consistency, and the presence of `testsv2/`. The index files
(`index.calldata.json`, `index.eip712.json`) are **auto-generated — do not edit them**. A human
reviewer checks only two things: that the `intent` strings are honest, and that any
`visible: "never"` fields are genuinely irrelevant. This descriptor marks nothing invisible — all
three functions display every argument.

One entity folder per PR: `registry/klaxon/` and nothing else.
