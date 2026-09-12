# Ledger developer feedback

KLAXON is built on the Ledger Key Ring Protocol through `@ledgerhq/wallet-cli` 2.1.0 and
`@ledgerhq/ledger-key-ring-protocol` 0.15.2 (Node 22 on the laptop, Node 24 in CI), September 2026.
Below is one bug in shipped code, then the developer-experience notes in the order we hit them.

> ### Status: device-verified
>
> Every device-dependent claim below was observed with a physical **Ledger Nano S Plus** on
> 2026-09-12. `ring init` enrolled a trustchain, the device signed four registry transactions on
> Sepolia, and `scripts/gate-a.sh` passes both halves. The one thing this document still owes is
> screenshots — `docs/img/` is empty.

## How to read this document

Every item carries a status, because this is a five-day hackathon build and the honest position
matters more than a tidy one:

- **Status: verified** — checked against shipped code in `node_modules`, or against the real
  `wallet-cli` 2.1.0 binary on this machine. No device required to reproduce.
- **Status: device-verified** — observed on 2026-09-12 with a Nano S Plus attached, through
  `scripts/gate-a.sh`: `ring init` on the device, `klaxon export-member`, then headless
  `restoreTrustchain` + `ringDecrypt` in a clean `node:24-bookworm-slim` container, cross-checked
  against real `wallet-cli ring decrypt`.

**This has been exercised against a physical Ledger.** `ring init` enrolled a Nano S Plus, the
device signed `register`, two `commitPolicy` calls and an `unrevoke` on Sepolia, and the resulting
trustchain restores headlessly on a host with no device attached.
`packages/core/test/wallet-cli-interop.test.ts` — the M10 acceptance criterion — passes in both
directions against the real binary. Anything still established only by reading Ledger's published
code says so where it appears. Screenshots are listed in "Screenshots owed" at the end;
`docs/img/` is still empty.

---

## 0. A bug: a permission check in `hw-ledger-key-ring-protocol` that cannot fire

**Status: verified.** Reproducible from `node_modules` with no device and no network.

Package `@ledgerhq/hw-ledger-key-ring-protocol@0.10.7`, pulled in as a direct dependency of
`@ledgerhq/ledger-key-ring-protocol@0.15.2`. Same line in all three builds:

- `src/CommandStreamResolver.ts:137`
- `lib-es/CommandStreamResolver.js:87`
- `lib/CommandStreamResolver.js:91`

In `CommandStreamResolver.assertIssuerCanPublish`:

```js
if ((internals.permission.get(crypto.to_hex(issuer)) & 0x02) === Permissions.KEY_READER) {
    throw new Error("Issuer does not have permission to publish keys at height " + internals.height);
}
```

`Permissions.KEY_READER` is `0x01` (`src/CommandBlock.ts:27`, `lib-es/CommandBlock.js:19`,
`lib/CommandBlock.js:26`). The expression `x & 0x02` can only ever be `0x00` or `0x02`. It is never
`0x01`, so the condition is unreachable and the guard never throws. Every issuer passes this check
regardless of its permission bits.

The mask and the constant also disagree about intent — `0x02` is `KEY_CREATOR`, not `KEY_READER` —
so there are two plausible readings and we cannot tell which was meant:

- *"the issuer lacks `KEY_CREATOR`"* → `(perm & Permissions.KEY_CREATOR) !== Permissions.KEY_CREATOR`.
  But the very next block in the same function already performs exactly that test, which would make
  this one redundant.
- *"the issuer is only a `KEY_READER`"* → `(perm & Permissions.KEY_CREATOR) === 0`, or a comparison
  against `KEY_READER` without the `& 0x02` mask.

We are not proposing a patch, because the two readings have different security meanings and only
you know which one the protocol wants. We are reporting that the line as written is dead.

### The neighbouring `Permissions` constants look like a hex/decimal slip

**Status: verified** as constant definitions. **Not verified** as an exploitable path — see below.

`Permissions` (`src/CommandBlock.ts:26–37`) reads as a bit series for four entries and then stops
being one:

| Name | Literal | Decimal | Binary |
|---|---|---|---|
| `KEY_READER` | `0x01` | 1 | `00000001` |
| `KEY_CREATOR` | `0x02` | 2 | `00000010` |
| `KEY_REVOKER` | `0x04` | 4 | `00000100` |
| `ADD_MEMBER` | `0x08` | 8 | `00001000` |
| `REMOVE_MEMBER` | `0x16` | **22** | `00010110` |
| `CHANGE_MEMBER_PERMISSIONS` | `0x32` | **50** | `00110010` |
| `CHANGE_MEMBER_NAME` | `0x64` | **100** | `01100100` |

`16`, `32`, `64` are the decimal continuation of `1, 2, 4, 8` — written with a `0x` prefix. If the
series was meant to continue as single bits, the last three should be `0x10`, `0x20`, `0x40`. As
written they are multi-bit values that overlap the flags above them:

- `0x16 == KEY_CREATOR | KEY_REVOKER | 0x10`. A member holding `REMOVE_MEMBER` passes any
  `& KEY_CREATOR` test **and** any `& KEY_REVOKER` test.
- `0x32 == KEY_CREATOR | 0x10 | 0x20`. Same collision with `KEY_CREATOR`.
- `0x64 == KEY_REVOKER | 0x20 | 0x40`. Collides with `KEY_REVOKER`.

We did **not** find a call site in this package that grants `REMOVE_MEMBER`,
`CHANGE_MEMBER_PERMISSIONS` or `CHANGE_MEMBER_NAME`, so we are not claiming a live privilege
escalation. We are reporting that the constants cannot be used as a bitmask as defined, and that a
future grant of any of the three would silently confer key-creator or key-revoker rights.

**Ask:** fix or delete the dead check at `CommandStreamResolver.ts:137`; if the three permissions
are meant to be flags, renumber them to `0x10/0x20/0x40`; if they are meant to be enum values
rather than flags, they should not be tested with `&` anywhere.

---

## 1. `addMember` and `destroyTrustchain` do not take a `deviceId`; `removeMember` does

**Status: verified** from `@ledgerhq/ledger-key-ring-protocol@0.15.2`, `lib-es/types.d.ts`:

```ts
removeMember(deviceId: string, trustchain, memberCredentials, member, callbacks?): Promise<Trustchain>;  // :155
addMember(trustchain, memberCredentials, member): Promise<void>;                                          // :159
destroyTrustchain(trustchain, memberCredentials): Promise<void>;                                          // :163
```

Removing a member needs the device. Adding one, and destroying the whole trustchain, need only the
member credential. Once a headless credential exists — which is the entire point of a CI
integration — that credential can enrol a permanent new member and can tear the trustchain down,
with no hardware in the loop.

We do not think this is a bug; it follows from the trustchain design. But it is not what a reader
assumes from "hardware-rooted", and it is not stated in the docs, so we assumed the opposite and had
to correct our own threat model (`docs/THREAT-MODEL.md`).

**Ask:** one sentence in the LKRP documentation saying which operations require the device and which
do not, and why `removeMember` is the asymmetric one.

---

## What worked

- `restoreTrustchain` is a headless call: plain Node, no native modules, no device parameter
  (`types.d.ts:147`). Once the install issue in §5 is worked around, the whole runner-side path is
  `node:crypto` plus the SDK. **Status: verified** (signature and implementation read); **pending
  Gate A** for "it actually returns a usable key on a real trustchain".
- `ring encrypt` is a clean primitive (HKDF domain key + AES-256-GCM). We built a two-share scheme
  on top of it without touching the Device Management Kit. **Status: verified** — our
  implementation is checked byte-for-byte against WebCrypto in `packages/core/test/domain-key.test.ts`,
  which uses the same API `wallet-cli` calls.
- `wallet-cli send` offers `--output json`, `--dry-run` and `--device-timeout`, which is exactly the
  set a script needs. **Status: verified** from `wallet-cli send --help` on 2.1.0. We have not yet
  used them against a device, so we cannot say what the rehearsal loop feels like — that is
  Gate A/M3.
- `--output json` is **not one envelope**. `--version` and `--help` answer
  `{"ok": true, "data": {...}}`, but a device-signed `send` **streams NDJSON**: one or more
  `{"type": "device-state", ...}` progress events while the device waits for approval, then a flat
  `{"status": "success", ..., "tx_hash": "0x…"}` result. **Status: device-verified** (captured
  2026-09-12). A single `JSON.parse()` of that stdout throws, which is the obvious thing for a
  caller to do and cost us a debugging session mid-demo. The result key is also snake_case
  `tx_hash` where the surrounding surface is camelCase, so a parser looking for `txHash` silently
  reports no transaction for one that in fact landed on chain. **Ask:** document the streaming
  shape, or gate it behind `--progress` so `--output json` stays a single object.
- `ring init` is a single command from a blank device to a trustchain, with `--name` and
  `--output json`. **Status: device-verified** — it does exactly that. One approval on the device,
  and the member key lands in the macOS keychain under `service=ledger-wallet-cli`. Choosing
  "Always Allow" at the keychain prompt is what makes every later command non-interactive.

## Friction

### 1. The member key cannot leave the keychain

**Status: verified** that no export path exists — `wallet-cli ring --help` on 2.1.0 lists exactly
`init`, `encrypt`, `decrypt`, `keys`, `destroy`. **Pending Gate A** for the keychain layout, which
we read out of the CLI bundle rather than out of a live keychain entry.

`ring init` stores the member private key in the OS keychain (`service=ledger-wallet-cli`,
`account=member-private-key-<sha256(stateDir)[:16]>`). With a password set it is wrapped as
`ENC:<hex>`: PBKDF2-HMAC-SHA256, 600 000 iterations, salt from `session.yaml`, then AES-256-GCM.
There is no `ring export` or `ring import`. A headless host therefore cannot become a trustchain
member without a device, or without reading the keychain layout. We wrote `klaxon export-member`
(`packages/cli/src/commands/export-member.ts`) to read and unwrap the entry and print a member
credential once. That code has never run against a real entry.

**Ask:** `wallet-cli ring export-member --json` and `import-member`, with a warning, or a documented
credential file format. Reverse-engineering a keychain layout is the wrong way for a third party to
reach a supported outcome.

### 2. `WALLET_PASS` is a laptop concept

**Status: verified** — it follows from §1 and from `ring init --unsecure-no-password`, which is the
only documented alternative.

The password unwraps a keychain entry; CI has no keychain. Once the credential is exported the
password protects nothing on the runner.

**Ask:** document the headless model — "the exported member credential is the secret" — rather than
leaving people to discover it.

### 3. `restoreTrustchain` calls Ledger's backend every time

**Status: verified** from the implementation. `SDK.restoreTrustchain` (`lib-es/SDK.js:112`) goes
through `withAuth` — a JWT challenge–response against Ledger's trustchain API — and then
`fetchTrustchainAndResolve`. There is no offline derivation of `walletSyncEncryptionKey` from the
member key.

Every KLAXON release therefore depends on that API being reachable. We fail closed before paying and
say so in `docs/THREAT-MODEL.md`.

**Ask:** availability expectations on a status page, and an SDK option for callers who want to cache
the key under their own encryption. We chose not to cache.

### 4. `getSdk` requires a device callback for restore-only use

**Status: verified** from `lib-es/index.d.ts:5`:

```ts
getSdk: (isMockEnv: boolean, context: TrustchainSDKContext, withDevice: WithDevice, lifecycle?: TrustchainLifecycle) => TrustchainSDK;
```

`withDevice` is positional and required, even for a caller that will only ever call
`restoreTrustchain`. We pass a stub that throws.

**Ask:** make `withDevice` optional, or expose a restore-only factory.

### 5. The SDK does not install out of the box

**Status: verified.** `npm view @ledgerhq/live-dmk-speculos` returns `E404` today
(2026-09-09). The chain, from `pnpm-lock.yaml`:
`@ledgerhq/ledger-key-ring-protocol@0.15.2` → `@ledgerhq/speculos-transport@0.10.6` →
`@ledgerhq/live-dmk-speculos` (unpublished). The install stops there.

We override it with an empty stub package (`pnpm-workspace.yaml` → `stubs/empty`). It is a device
emulator transport, unused by `restoreTrustchain`, so the stub costs us nothing — but every consumer
of the Key Ring SDK has to discover this and invent the same workaround.

**Ask:** publish it, or make the Speculos edge optional for consumers that never emulate a device.

### 6. `ring encrypt`'s format is undocumented

**Status: verified** that it is undocumented — `wallet-cli ring encrypt --help` documents `--key`,
`-i`, `-o`, `--output` and nothing about the output bytes. **Verified** that our reading of the
format is self-consistent against WebCrypto. **Pending Gate A** for the interop claim.

We extracted the CLI bundle to learn it:
`HKDF-SHA256(walletSyncEncryptionKey, salt="wallet-cli-domain-v1", info=<key name>)` derives the
key; AES-256-GCM produces `iv(12) ‖ ciphertext ‖ tag(16)`. Our implementation is checked
byte-for-byte against WebCrypto in `packages/core/test/domain-key.test.ts`.

That claim is settled: **real `wallet-cli ring decrypt` opens our blobs, and our `ringDecrypt`
opens real `ring encrypt` blobs**. `packages/core/test/wallet-cli-interop.test.ts` drives the real
binary in both directions and passes against a provisioned ring
(`KLAXON_WALLET_CLI_INTEROP=1 KLAXON_TEST_WSEK=… pnpm vitest run`). This is the M10 acceptance
criterion, and it is what makes reading the format out of a bundle defensible at all: the CLI stays
the specification, and our implementation is contract-tested against it rather than trusted.

**Ask:** write the format down. It is a good primitive and third parties will build on it, which is
exactly what we did — from a disassembled bundle, which is not a supportable position for either of
us.

### 7. `send` has no `--network`; account labels and JSON output are unspecified

**Status: verified** from the 2.1.0 binary. `wallet-cli send --help` lists
`--account/-a, --to/-t, --amount, --fee-per-byte, --rbf, --mode, --validator, --stake-account,
--memo, --data, --dry-run, --output, --device-timeout`. There is no `--network`. The network rides
entirely on the session label that `account discover` assigned, and the shape of
`send --output json` is not documented, so scripts have to pin to one captured response.

Two smaller notes from the same help output:

- `account discover --help` gives `"ethereum:goerli"` as its network example. Goerli has been dead
  since 2023; a reader copying the example gets a network that no longer exists.
- `--memo` is documented as "Solana only", which is easy to misread as a general memo field.

**Ask:** a `--network` flag on `send`, a JSON schema for `--output json`, and a live testnet in the
`discover` example.

### 8. No typed-data signing

**Status: verified.** `wallet-cli --help` on 2.1.0 lists `account, assets, balances, earn,
genuine-check, operations, receive, ring, send, session, skill, swap`. There is no
`sign-typed-data`, and no typed-data option under `send`.

Anything that wants an EIP-712 signature has to become a contract call. We route policy commits and
unrevokes through `KlaxonRegistry` for that reason — a deliberate design change forced by a missing
command, not a preference.

### 9. Blind signing, with no path to a testnet descriptor

**Status: verified** for the ERC-7730 registry constraint and for the descriptor we wrote
(`packages/contracts/erc7730/`). **Not yet true:** the Base deployment.

`commitPolicy(bytes32,bytes32)` shows raw calldata on the device. The ERC-7730 registry takes
mainnet chain ids only, so a hackathon project has to deploy to a mainnet purely to be allowed to
file a descriptor for a contract whose only real use is on a testnet. Our plan (decision D13) is to
deploy `KlaxonRegistry` to Base mainnet for exactly that reason and file against `chainId 8453`.

**As of 2026-09-09 nothing is deployed on any chain** — `packages/contracts/` has no `broadcast/`
directory, and no descriptor has been filed. The descriptor JSON and its `testsv2/` cases are
written and committed; that is all.

**Ask:** accept testnet chain ids, or provide a developer side-load for descriptors in Ledger Live.
Requiring a mainnet deployment as the price of clear signing prices out exactly the developers who
most need to test the flow.

### 10. `ring` is a hardware-rooted secrets primitive with no README

**Status: verified.** `ring` appears in `wallet-cli --help` with a one-line description and has its
own `--help`, but the subcommand is absent from the wallet-cli README, and there is no written
account of the trustchain model, the key-name namespace, or the ciphertext format (§6).

**Ask:** a README section for `ring` with the trustchain model in one paragraph, and a statement of
what the key name in `--key` is scoped to.

### 11. The design discussion is only findable in pull requests, two of which are closed

**Status: verified** against the GitHub API on 2026-09-09.

Searching for `ring` leads to a closed PR, which reads as abandoned work until you keep digging:

| PR | Title | State |
|---|---|---|
| [#16859](https://github.com/LedgerHQ/ledger-live/pull/16859) | `feat(wallet-cli): secrets command group — hardware-backed file encryption` | closed, not merged (2026-05-11) |
| [#17743](https://github.com/LedgerHQ/ledger-live/pull/17743) | `feat(wallet-cli): add ring command group (Ledger Key Ring / LKRP)` | closed, not merged (2026-07-10) |
| [#19477](https://github.com/LedgerHQ/ledger-live/pull/19477) | `feat(wallet-cli): add ring command group (Ledger Key Ring / LKRP)` | **merged** (2026-07-10) |

The feature shipped — #19477 is the merged one, and it landed 61 minutes after #17743 was closed with
an identical title. But the two closed PRs are what a search surfaces first, and #16859 is where the
best material is: it carries a section headed *"Password injection without a TTY (agentic / CI)"*,
which is precisely the use case we are building on and is not documented anywhere else.

**Ask:** if the design rationale lives in PR descriptions, link the merged one from the wallet-cli
README, and consider moving the agentic/CI note out of the closed #16859 and into the docs. We
nearly abandoned this integration because the only design document we could find said "closed".

---

## Screenshots owed

`docs/img/` is empty. Each of these needs the physical device before it can be captured:

| Marker | Shows | Blocked on |
|---|---|---|
| `ring-init` | `wallet-cli ring init` and the device-side Ledger Sync flow | device |
| `keychain-entry` | the `ENC:`-wrapped keychain entry (§1) | `ring init` |
| `install-404` | the `E404` for `@ledgerhq/live-dmk-speculos` (§5) | nothing — capturable now |
| `blind-sign` | the blind-signing prompt for `commitPolicy` (§9) | device + a deployment |
