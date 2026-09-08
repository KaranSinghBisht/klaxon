# Ledger developer feedback

KLAXON is built on the Ledger Key Ring Protocol through `@ledgerhq/wallet-cli` 2.1.0 and `@ledgerhq/ledger-key-ring-protocol` 0.15.2 (Node 22 on the laptop, Node 24 in CI), September 2026. Below is what we hit, in the order we hit it, what we did about it, and what would have made the workaround unnecessary. Screenshots are marked `[screenshot: name]` and live in `docs/img/`.

## What worked

- `wallet-cli ring init` is one command from a blank device to a trustchain, and the Ledger Sync flow on the device is clear. `[screenshot: ring-init]`
- `restoreTrustchain` runs headless on plain Node with no native modules. Once the install issue below is patched, the whole runner-side path is `node:crypto` plus the SDK.
- `ring encrypt` is a clean primitive (HKDF domain key + AES-256-GCM). We built a two-share scheme on top of it without touching the Device Management Kit.
- `wallet-cli send --output json --device-timeout` is exactly what a script needs, and `--dry-run` made rehearsing the device beats cheap.

## Friction

### 1. The member key cannot leave the keychain

`ring init` stores the member private key in the OS keychain (`service=ledger-wallet-cli`, `account=member-private-key-<sha256(stateDir)[:16]>`). With a password set it is wrapped as `ENC:<hex>`: PBKDF2-HMAC-SHA256, 600 000 iterations, salt from `session.yaml`, then AES-256-GCM. There is no `ring export` or `ring import`. A headless host therefore cannot become a trustchain member without a device, or without reading the keychain layout. We wrote `klaxon export-member` (`packages/cli/src/commands/export-member.ts`), which reads and unwraps the entry and prints a member credential once. `[screenshot: keychain-entry]`

**Ask:** `wallet-cli ring export-member --json` and `import-member`, with a warning, or a documented credential file format.

### 2. `WALLET_PASS` is a laptop concept

The password unwraps a keychain entry; CI has no keychain. Once the credential is exported the password protects nothing on the runner.

**Ask:** document the headless model, "the exported member credential is the secret", rather than leaving people to discover it.

### 3. `restoreTrustchain` calls Ledger's backend every time

`walletSyncEncryptionKey` is recomputed through a challenge–response against `trustchain.api.live.ledger.com`; there is no offline derivation from the member key. Every KLAXON release therefore depends on that API being reachable. We fail closed before paying and say so in `docs/THREAT-MODEL.md`.

**Ask:** availability expectations on a status page, and an SDK option for callers who want to cache the key under their own encryption. We chose not to cache.

### 4. `getSdk` requires a device callback for restore-only use

`getSdk(false, ctx, withDevice)` insists on `withDevice`; we pass a stub that throws.

**Ask:** make `withDevice` optional, or expose a restore-only factory.

### 5. The SDK does not install out of the box

`@ledgerhq/ledger-key-ring-protocol@0.15.2` depends, through `@ledgerhq/speculos-transport`, on `@ledgerhq/live-dmk-speculos`, which is not published. npm answers 404 and the install stops. We override it with an empty stub package (see `pnpm-workspace.yaml`). `[screenshot: install-404]`

**Ask:** publish it, or make the Speculos edge optional for consumers that never emulate a device.

### 6. `ring encrypt`'s format is undocumented

We extracted the CLI bundle to learn it: `HKDF-SHA256(walletSyncEncryptionKey, salt="wallet-cli-domain-v1", info=<key name>)` derives the key; AES-256-GCM produces `iv(12) ‖ ciphertext ‖ tag(16)`. Our implementation is checked byte-for-byte against WebCrypto (`packages/core/test/domain-key.test.ts`) and `wallet-cli ring decrypt` opens our blobs.

**Ask:** write it down. It is a good primitive and third parties will build on it, which is exactly what we did.

### 7. `send` has no `--network`; account labels and JSON output are unspecified

The network rides on the label `account discover` assigns, and the shape of `send --output json` is not documented, so scripts pin to one captured response.

**Ask:** a `--network` flag, and a JSON schema for `--output json`.

### 8. No typed-data signing

There is no `sign-typed-data`; anything that wants an EIP-712 signature has to become a contract call. We route policy commits and unrevokes through `KlaxonRegistry` for that reason.

### 9. Blind signing, with no path to a testnet descriptor

`commitPolicy(bytes32)` shows raw calldata on the device. The ERC-7730 registry takes mainnet chain ids only, so a hackathon project must deploy to a mainnet to file a descriptor. We deployed to Base for exactly that. `[screenshot: blind-sign]`

**Ask:** accept testnet chain ids, or a developer side-load for descriptors in Ledger Live.

### 10. Finding `ring` at all

The subcommand is not in the wallet-cli README; the design we found lives in a closed pull request (#17743). <!-- TODO(user): confirm the PR link before submission -->

**Ask:** a README section for `ring` with the trustchain model in one paragraph.
