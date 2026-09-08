# `@klaxon/cli`

The operator command line. Everything a human does to a KLAXON project happens here: creating it,
exporting the runner credential, encrypting secrets into the repo, rotating them, pulling the
alarm, and breaking glass when the witness is gone.

```
klaxon init            create the project (Key Ring, HCS topic, witness, Sepolia)
klaxon export-member   print the KLAXON_MEMBER secret, once
klaxon policy commit   anchor klaxon.policy.json on Sepolia
klaxon add <NAME>      encrypt a secret into .klaxon/<NAME>.enc
klaxon rotate <NAME>   re-encrypt at the next generation
klaxon get <NAME>      release a secret on a runner
klaxon revoke          stop every release for the project
klaxon unrevoke        lift a revocation (needs the Ledger)
klaxon emergency <N>   recover a secret with no witness at all
```

`wallet-cli` is shelled out to for exactly three things, all of them device moments: `ring init`
and the two `send --data` calls. Everything else uses the SDK directly.

---

## Install and run

Node 22+. Inside the monorepo:

```bash
pnpm --filter @klaxon/cli dev -- --help      # tsx, no build
pnpm --filter @klaxon/cli build              # dist/bin.js, exposed as `klaxon`
```

`WALLET_CLI_BIN` overrides the `wallet-cli` binary name if it is not on `PATH`.

---

## `klaxon init`

```bash
klaxon init \
  --repository acme/demo \
  --repository-id 123456789 \
  --witness https://witness.example \
  --registry 0xREGISTRY \
  [--project demo] [--chain-id 11155111] [--network ethereum:sepolia] \
  [--hedera-account 0.0.4242] [--hedera-key 0x…] [--hedera-key-type ecdsa|ed25519] \
  [--hedera-network testnet] [--skip-ring-init] [--dry-run] [--print-only]
```

In order:

1. `wallet-cli ring init` — the device moment that creates the trustchain.
2. Reads `session.yaml` for `trustchain.rootId` and `applicationPath`.
3. `wallet-cli account discover --network ethereum:sepolia --output json`; the account label is
   **read out of the JSON** and cached in `~/.klaxon/config.json`. Nothing hardcodes
   `ethereum-sepolia-1` or `ethereum_sepolia-1` — see [Day-1 captures](#day-1-captures-still-owed).
4. `project_id = sha256(utf8(repository_id) ‖ 0x00 ‖ utf8(rootId))`.
5. `GET {witness}/.well-known/klaxon.json` for `submit_key` and `hedera_account`.
6. Creates the HCS topic with `setSubmitKey(witness)` and `setAdminKey(this laptop)` — one topic
   per project, and only the witness can ever write to it.
7. `POST /projects`, member-signed.
8. Writes a `klaxon.policy.json` skeleton and `~/.klaxon/config.json`.
9. `register(project_id)` then `commitPolicy(project_id, policy_hash)` — **two approvals in one
   device session**, calldata built with viem.

`--print-only` stops before step 9. `--dry-run` runs step 9 through `wallet-cli --dry-run`, which
prepares and validates the transactions without asking the device — use it to rehearse.

The laptop's Hedera account (`HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY`) owns the topic's admin
key. Keys are parsed as ECDSA by default; pass `--hedera-key-type ed25519` for an older account.

---

## `klaxon export-member`

```bash
klaxon export-member                # one base64 line on stdout — this is KLAXON_MEMBER
klaxon export-member --wrap         # ENC:-wrapped variant, needs WALLET_PASS
```

Reads the macOS keychain entry `@napi-rs/keyring` addresses as:

| | |
|---|---|
| service | `ledger-wallet-cli` |
| account | `member-private-key-<sha256(stateDir)[:16]>` |
| `stateDir` | `$XDG_STATE_HOME/ledger-wallet-cli`, else `~/.local/state/ledger-wallet-cli`, resolved absolute |

The stored value is `value.trim().split(/\r?\n/)`:

- line 0 — the private key, either raw 64-hex or `ENC:` + `hex(iv(12) ‖ ct ‖ tag(16))`
- line 1 — the compressed public key, **optional**; derived from the private key when absent

Unwrapping an `ENC:` line needs `WALLET_PASS` in the environment and `passwordSalt` from
`session.yaml`:

```
key = PBKDF2-HMAC-SHA256(utf8(WALLET_PASS), hexToBytes(passwordSalt), 600000, 32)
priv = utf8(AES-256-GCM-open(key, iv, ct, tag))
```

600 000 iterations and the 16-byte salt are literal constants in the wallet-cli 2.1.0 binary.

Output is a single base64 line — `base64(JSON({v, rootId, applicationPath, applicationId: 17,
privatekey, pubkey}))` — printed once to stdout and never written to disk. `--out` accepts only
`-`; redirect stdout yourself if it has to land in a file.

`security find-generic-password` (and this command, through the same keychain) can raise a macOS
prompt. Run it once before filming and choose **Always Allow**.

### Why plaintext is the default (D3)

Appendix A made `--wrap` the default so a stolen `KLAXON_MEMBER` would still need `WALLET_PASS`.
D3 overrides that: the threat model already concedes the member credential to the in-scope
attacker — anyone who can read the runner's secrets — and a second secret sitting in the same
environment buys nothing against them. It only adds a way for a release to fail at 3 a.m.

`--wrap` remains available and re-wraps under a **fresh 16-byte salt** carried in the JSON. Note
that its output is deliberately *not* a `KlaxonMember`: core's schema requires a bare 64-hex
`privatekey`, so `decodeMember` rejects the wrapped envelope, and the shipped action has no
unwrap step. Use it only if you are also supplying the runner-side unwrap.

---

## `klaxon policy commit`

```bash
klaxon policy commit [--file klaxon.policy.json] [--print-only] [--dry-run]
```

`policy_hash = sha256(the exact committed bytes of klaxon.policy.json)` — never a
re-serialization. `klaxon policy commit`, the witness and `verify` all hash the same raw bytes,
so **running a formatter over the policy file is a policy change** and has to be re-committed.

The hash and the calldata are printed before the device is asked for anything, so what the Ledger
blind-signs can be compared against what is on screen.

---

## `klaxon add` / `klaxon rotate`

```bash
printf '%s' "$VALUE" | klaxon add DEPLOYER_PRIVATE_KEY
printf '%s' "$NEW"   | klaxon rotate DEPLOYER_PRIVATE_KEY
```

Options: `--project <name>`, `--file <path>` (instead of stdin), `--raw` (keep the trailing
newline; by default one is stripped), `--force` (`add` only).

1. `POST /shares` (or `/rotate`), member-signed → `{b, b_hash}`. **The witness derives B** from
   its master and stores only `(project, secret, gen, b_hash)` — D28.
2. `restoreTrustchain` → the wallet-sync key. Network call to Ledger, never cached.
3. `DK` fresh; `ct = AES-256-GCM(DK, plaintext, aad = {project_id, secret, gen})`;
   `A = DK ⊕ B`; `a_ct = ringEncrypt(wsek, "klaxon/<project_id>/<NAME>/<gen>", A)`.
4. Writes `.klaxon/<NAME>.enc`. Commit it — it is ciphertext, and the repo is where it belongs.

`a_ct` is byte-identical to `wallet-cli ring encrypt --key <a_key_name>`, so
`wallet-cli ring decrypt` opens it.

`rotate` reads the current generation out of the existing `.enc` and moves to N+1; the witness
retires generation N when it answers `/rotate`.

---

## `klaxon get`

```bash
klaxon get DEPLOYER_PRIVATE_KEY --transport ./transport.mjs
```

The runner path. It refuses to print to a TTY unless `--i-know-what-im-doing`, and in CI
(`GITHUB_ACTIONS=true` or `CI=true`) it writes `::add-mask::<value>` lines **before** the value,
each on its own line.

**There is no payment transport in this package.** The x402 client lives in `packages/action`,
which is the only package allowed to load `@x402/*` — two copies of a Hedera SDK in one package
break `instanceof` (D33). In CI, use the action. Elsewhere, `--transport <module>` names a module
exporting:

```js
export function createTransport({ witnessUrl, env, fetchImpl }) {
  return { async release(h, { C, jwt, sig }) { /* pay the 402, POST, return the body */ } };
}
```

Without `--transport`, the command fails immediately and says this.

---

## `klaxon revoke` / `klaxon unrevoke`

```bash
klaxon revoke --reason "laptop seized"
klaxon unrevoke [--epoch 7] [--print-only] [--dry-run]
```

`revoke` is member-signed and needs no device: it has to be reachable from a phone tether at
3 a.m. with the Ledger nowhere nearby. The witness answers with an epoch, which is recorded in
`~/.klaxon/config.json`.

`unrevoke` is the part that costs a device approval. The epoch is monotonic on chain, so it
submits **last known + 1**; `--epoch` overrides when the chain is ahead of this laptop's file.

---

## `klaxon emergency`

```bash
WITNESS_MASTER=<64 hex> klaxon emergency DEPLOYER_PRIVATE_KEY \
  --pay-account 0.0.1234 --pay-key 0x… > /dev/null
```

Break glass. With the paper-backed master and the repo, no witness is needed at all:

```
B  = HKDF-SHA256(WITNESS_MASTER, salt="klaxon/b/v1", info=project_id/secret/gen, 32)
A  = ringDecrypt(wsek, a_key_name, a_ct)
DK = A ⊕ B    →  plaintext = AES-256-GCM-open(DK, ct, aad)
```

`sha256(B)` is checked against `b_hash` before anything is decrypted, so a wrong master fails
loudly instead of producing garbage.

It then sends a **plain `TransferTransaction` with `setTransactionMemo(h)`** from the laptop's own
Hedera account, so a break-glass recovery still leaves the same kind of public, timestamped trace
a paid release does. `--no-pay` skips it and says out loud that nothing was recorded.

Two caveats, stated plainly:

- **Ledger's backend is required.** `restoreTrustchain` is what turns the member credential into
  the wallet-sync key that opens share A, and it is a live network call every time. If Ledger's
  API is down, `emergency` cannot run either. This is a disclosed liveness dependency, not a
  workaround for one.
- `h` here is *not* a release commitment. PROTOCOL §1's `h` hashes a `Commitment` full of GitHub
  claims this path does not have, and §7's `emergency` HCS message defines no hash of its own, so
  this command commits to its own canonical object —
  `{v:1, type:"emergency", project_id, secret, gen, ts}` hashed with RFC 8785 — and uses that as
  the memo. See [Open questions](#open-questions).

---

## What CI needs

Two GitHub **secrets** and one **variable**:

| Name | Kind | Value | Produced by |
|---|---|---|---|
| `KLAXON_MEMBER` | secret | the single base64 line | `klaxon export-member` |
| `KLAXON_PAY_KEY` | secret | Hedera ECDSA private key, `0x…` | Hedera portal account |
| `KLAXON_PAY_ACCOUNT` | **variable** | `0.0.1234567` | the same account |

`KLAXON_PAY_ACCOUNT` is a repository variable, not a secret — it is a public account id, and
keeping it out of the secret store means one less thing GitHub masks in logs where you need to
read it. The runner needs no HBAR for gas: the facilitator's fee payer covers it, and
`KLAXON_PAY_KEY` only funds the transfers themselves.

`WALLET_PASS` is **not** a runner secret (D3). It is only ever read on the laptop, by
`export-member`.

---

## Files this CLI owns

| Path | Contents |
|---|---|
| `~/.klaxon/config.json` | project coordinates: ids, witness URL, topic, registry, member pubkey, last epoch, cached account label. Mode 0600. |
| `~/.klaxon/witness-master.key` | only when you self-host the witness. Mode 0600. `emergency` falls back to it when `WITNESS_MASTER` is unset. |
| `./klaxon.policy.json` | committed to the repo, hashed as exact bytes, anchored on Sepolia. |
| `./.klaxon/<NAME>.enc` | committed to the repo. Ciphertext, share A, `b_hash`. |

The member private key is **never** in any of them — it stays in the OS keychain. `KLAXON_HOME`
relocates `~/.klaxon` (the test suite uses it; so can you).

---

## Day-1 captures still owed

Two things cannot be settled without the Ledger attached, and both are marked in the source with
`// TODO(day1): pin to captured real output`:

1. **The `wallet-cli --output json` envelope.** Appendix A read `{status:"success", …}` out of the
   binary; appendix B read `{ok:true, data:{…}}`. `parseWalletCliEnvelope` accepts **both** and
   normalises them. Capture one real `wallet-cli send --output json` response and narrow it.
2. **The Sepolia account label.** `ethereum-sepolia-1` vs `ethereum_sepolia-1`. Nothing hardcodes
   either: `account discover --output json` runs first and the label is read from the JSON, then
   cached in `~/.klaxon/config.json`. Capture the real value and confirm.

The shape of `data.*` for `send` is unknown for the same reason, so `extractTxHash` searches the
payload for a `0x`-prefixed 32-byte hash under any plausible key and reports "no tx hash in
wallet-cli output" rather than failing when it finds none.

---

## Open questions

- **`klaxon verify`** is listed in appendix A's command map as a re-export of `@klaxon/verify`.
  It is not wired here: `@klaxon/verify` is not a dependency of this package, and adding one would
  couple the operator CLI to the independent verifier — which is the one thing D5 says must share
  no code. Run `npx klaxon-verify` directly.
- **The `emergency` HCS message.** PROTOCOL §7 says an `emergency` message is "published by the
  operator's laptop key", but §7 also fixes the topic's submit key to the **witness**, so the
  laptop cannot submit to its own project topic. This command therefore pays the memo transfer and
  stops there. Resolving it needs either a second topic or a submit-key change.

---

## Testing

```bash
pnpm exec vitest run packages/cli
```

Every seam that touches a device, the OS keychain, the network or the clock is injected through
`CliDeps` and faked in `test/helpers.ts`. No test reaches the real keychain, a real `wallet-cli`,
Ledger's API or Hedera — the default fakes throw if one tries.
