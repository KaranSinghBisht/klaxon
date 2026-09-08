# `@klaxon/contracts` — `KlaxonRegistry`

The on-chain anchor for KLAXON: who owns a project, which release policy is in force, and which
revocation epoch is current. Three functions, three events, three mappings, no upgradeability, no
value held.

```solidity
register(bytes32 p)                    // permissionless, first-write-wins; sets owner[p]
commitPolicy(bytes32 p, bytes32 hash)  // onlyOwner; hash = sha256(klaxon.policy.json bytes)
unrevoke(bytes32 p, uint64 epoch)      // onlyOwner; strictly increasing
```

`p` is the project id, `sha256(repository_id || 0x00 || rootId)`. See `docs/PROTOCOL.md` §8.

This is a pure Foundry package — no `package.json`, not part of the pnpm workspace.

## Build and test

`lib/` is vendored, not a submodule, and is gitignored. On a fresh clone:

```bash
forge install foundry-rs/forge-std --no-git --shallow
```

Then:

```bash
forge build
forge test -vv
forge fmt          # forge fmt --check in CI
forge build --sizes
```

## Deploy

`DEPLOY_KEY` is a **throwaway EOA — never the Ledger.** Fund it from a Sepolia faucet, or with
~$0.30 of ETH on Base. Keeping deployment on a software key means the registry can be redeployed
as many times as needed without a single hardware approval; the device only ever *calls* the
contract.

```bash
export DEPLOY_KEY=0x…              # burner
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
export BASE_RPC_URL=https://mainnet.base.org
export ETHERSCAN_API_KEY=…         # Etherscan V2: one key, all chains

forge script script/Deploy.s.sol:Deploy --rpc-url sepolia --broadcast --verify \
  --private-key "$DEPLOY_KEY" --etherscan-api-key "$ETHERSCAN_API_KEY"

forge script script/Deploy.s.sol:Deploy --rpc-url base --broadcast --verify \
  --private-key "$DEPLOY_KEY" --etherscan-api-key "$ETHERSCAN_API_KEY"
```

**Record the logged block number** — it is the witness's `DEPLOY_BLOCK`, where the `getLogs` cursor
starts.

Etherscan V2 uses one key across chains; `--verify` picks the endpoint from the `chain` in
`foundry.toml`'s `[etherscan]` table. If verification flakes it retries independently:

```bash
forge verify-contract <addr> KlaxonRegistry --chain 11155111 --watch
forge verify-contract <addr> KlaxonRegistry --chain 8453      --watch
```

Also verify on **Sourcify** for the Base deployment — ERC-7730 reviewers are told to ask for it:

```bash
forge verify-contract <addr> KlaxonRegistry --chain 8453 --verifier sourcify
```

Sanity check that the deployment took:

```bash
cast call $REGISTRY "policyHash(bytes32)(bytes32)" $PID --rpc-url "$SEPOLIA_RPC_URL"
```

### Why both Base mainnet and Sepolia (ruling D13)

The demo runs on **Sepolia** — free, fast, and the registry is a coordination anchor rather than
anything holding value. But no descriptor in Ledger's clear-signing registry targets a testnet, and
the CI linter cannot fetch a reference ABI for an unverified testnet address, which makes a
Sepolia-only ERC-7730 PR un-reviewable at best. So the same contract also goes to **Base mainnet**
for ~$0.30 and the descriptor is filed against `chainId 8453`. A merged descriptor is a materially
stronger artifact than a filed one. Details in `erc7730/README.md`.

## Device-signing flow

Every state change is signed on the Ledger. The contract is never deployed by the device; it only
ever calls `register` / `commitPolicy` / `unrevoke`.

**Once, with the device attached** — capture the account label:

```bash
wallet-cli account discover --network ethereum:sepolia --output json
```

Read the saved label out of that JSON. Expect something like `ethereum_sepolia-1`, but **the exact
spelling is captured on Day 1** — the binary contains both `ethereum:sepolia` and
`ethereum_sepolia`, and this is the one thing here that needs hardware to settle (ruling D15). Pin
the parser to one captured real response.

**Then, per call:**

```bash
DATA=$(./scripts/calldata.sh commit-policy "$PID" "$POLICY_HASH")

wallet-cli send \
  -a <label from that JSON> \
  --to "$REGISTRY" \
  --amount "0 ETH" \
  --data "$DATA" \
  --output json \
  --device-timeout 180000
```

- `--device-timeout 180000` raises the 60 s default so a filming take does not expire mid-approval.
- `--dry-run` prepares and validates the transaction **without signing** — rehearse the demo with it
  and burn no device approvals.
- `send` has **no `--network`** flag; the network comes from the account label. `--memo` exists but
  is Solana-only.
- Run `register` and the first `commitPolicy` in the **same device session** (ruling D19) — two
  approvals back to back, one trip to the drawer.

> **Enable Blind signing on the Ethereum app before the shoot.** Until the ERC-7730 descriptor is
> merged, the device shows contract data plus a blind-signing prompt, and without the setting the
> call is simply rejected. Screenshot it for `docs/LEDGER-FEEDBACK.md`. The on-camera line is
> *"blind signing, because the descriptor for this deployment isn't merged yet — here's the PR."*

## `scripts/calldata.sh`

Encodes `--data` for `wallet-cli send` with `cast`, so neither the CLI nor the operator needs Node
or viem in the loop. Prints the calldata and nothing else.

```bash
./scripts/calldata.sh register      <projectId>
./scripts/calldata.sh commit-policy <projectId> <policyHash>
./scripts/calldata.sh unrevoke      <projectId> <epoch>
```

Arguments are validated before they reach `cast` — a truncated `bytes32` or an out-of-range epoch
fails here rather than producing a valid-looking transaction for the wrong bytes.

## ERC-7730 descriptor

`erc7730/calldata-KlaxonRegistry.json` and `erc7730/testsv2/calldata-KlaxonRegistry.tests.json`
target `registry/klaxon/` in
[`LedgerHQ/clear-signing-erc7730-registry`](https://github.com/LedgerHQ/clear-signing-erc7730-registry).
Regenerate the test vectors after deployment:

```bash
REGISTRY=0x<deployed> CHAIN_ID=8453 ./scripts/gen-erc7730-tests.sh
```

It runs offline — nonce, gas and chain id are all passed explicitly, so `cast mktx` never reaches
for an RPC.

**PR checklist**

- [ ] One entity folder only — `registry/klaxon/`, nothing else touched.
- [ ] `registry/klaxon/testsv2/calldata-KlaxonRegistry.tests.json` present (CI enforces test
      presence).
- [ ] Deployment addresses filled in; `rawTx` regenerated so each `to` matches a deployment.
- [ ] `metadata.info.deploymentDate` set to the real timestamp.
- [ ] Contract verified on Basescan **and** Sourcify.
- [ ] Descriptor validates against `specs/erc7730-v2.schema.json`:

      npx @ledgerhq/erc7730 lint registry/klaxon/calldata-KlaxonRegistry.json
      # if the linter is not published, validate with ajv against specs/erc7730-v2.schema.json

- [ ] Index files (`index.calldata.json`, `index.eip712.json`) **not** edited — they are
      auto-generated.
- [ ] `intent` strings read honestly to a human reviewer; nothing is hidden behind
      `visible: "never"`.

See `erc7730/README.md` for the chainId rationale and the full TODO list.
