# KLAXON protocol — the integration contract

Every package builds against this file. `@klaxon/core` exports the types and primitives named here
(`packages/core/src/index.ts`); the witness serves it; the action and cli consume it; `verify`
re-derives it from public data without importing core.

## 1. Values

- `project_id` = `sha256(utf8(repository_id) || 0x00 || utf8(trustchain.rootId))` hex. (`deriveProjectId`)
- `C` = the release commitment, `CommitmentSchema` — **all numerics are strings**:
  `{v:1, project_id, secret, gen, repository_id, run_id, run_attempt, environment, ephemeral_pub:{sig,enc}, ts}`.
  `environment` is `"(none)"` when the job has no environment claim — the request must still be paid and recorded.
- `h` = `sha256(canonicalize(C))` hex (RFC 8785). It is simultaneously the OIDC `aud` suffix
  (`klaxon:<h>`), the Hedera payment memo, the `/release/:h` path, and what `sig` covers.
- `sig` = ed25519 over `utf8("klaxon-release-v1:" + h)` by `ephemeral_pub.sig`, base64url. (`signCommitment`)
- Share B delivery = `EciesEnvelope {v:1, epk, ct, tag}` sealed to `ephemeral_pub.enc`, bound to `h`. (`eciesSeal`)
- `.klaxon/<NAME>.enc` = `EncFileSchema`. `a_ct` is byte-identical to `wallet-cli ring encrypt --key <a_key_name>`.

## 2. Witness HTTP API

All bodies JSON. Errors are `{ok:false, ...}` with the classes below.

| Route | Auth | Body → Response |
|---|---|---|
| `GET /health` | none | `{ok, db, facilitator, mirror, sepolia_cursor_lag_s}` — see below |
| `GET /.well-known/klaxon.json` | none | **200** manifest (§4). `?project=<id>` filters the list |
| `GET /release/:h` | none | **402** with x402 `PAYMENT-REQUIRED` header, `PaymentRequirements.extra.memo == h` \| **400** `h` not 64 lowercase hex \| **503** `{class:"infra", check:0}` facilitator unreachable |
| `POST /release/:h` | x402 `PAYMENT-SIGNATURE` header | body `{C, jwt, sig}` (`ReleaseRequestBody`) → **200** `ReleaseOk` \| **403** `ReleaseRefused` (auth/policy) \| **503** `ReleaseRefused{class:"infra"}` \| **400** bad `h` or unparseable body \| **402** twice over: no `PAYMENT-SIGNATURE` header (re-issues requirements) or settlement rejected |
| `POST /projects` | operator-signed | `{project_id, repository_id, repository, member_pubkey, topic_id, ntfy_topic}` → **200** `{ok:true}` \| 400 \| 401 |
| `POST /shares` | operator-signed | `{project_id, secret, gen}` → **200** `{ok:true, b: b64u(32), b_hash}` — witness **derives** B (§3) and records `(project, secret, gen, b_hash)`; first write wins \| 400 \| 401 \| 404 unknown project \| 409 already recorded |
| `POST /rotate` | operator-signed | `{project_id, secret, gen}` (new gen, must be current+1) → as `/shares` and retires the previous gen \| 409 when `gen != current+1` |
| `POST /revoke` | operator-signed | `{project_id, reason}` → **200** `{ok:true, epoch}` \| 400 \| 401 \| 404 |

`ReleaseOk = {ok:true, h, share_b: EciesEnvelope, hcs:{sequence_number, consensus_timestamp}}`
`ReleaseRefused = {ok:false, h, class:"auth"|"policy"|"infra", check: 0..9, reason, hcs?:{sequence_number, consensus_timestamp}, revoked?: boolean}` — `hcs` is present for auth/policy refusals (the refusal is published before the 403 is sent), never for infra.

**400 and 402 are not refusals.** A malformed `h`, a body that fails `ReleaseRequestBody`, or a
missing payment header is rejected *before* any payment is attempted, so it costs the caller nothing,
publishes nothing to HCS and revokes nothing. Only a request that got past settlement can reach the
nine checks and become a `ReleaseRefused`.

**`GET /health` is a Fly liveness probe, not a status page.** It runs four checks — a `SELECT` against
the database, the facilitator, the mirror node, and the Sepolia cursor lag — and answers **200** only
if all four pass, **503** otherwise, with the same body shape either way so the failing one is
visible. Two things a caller should know: `sepolia_cursor_lag_s` is `null` before the watcher has ever
persisted a cursor, and `null` counts as **failing**, so a freshly started witness is 503 until it has
read the chain once; and the lag threshold is 300 s. Failing closed is deliberate — Fly stops routing
to a red machine, which is correct for a witness that cannot settle payments or read the chain back.

The witness learns `pay_tx` from x402 settlement (`settle.transaction`); the body never carries it.
The client reads it back from the `PAYMENT-RESPONSE` header.

**Operator-signed requests** (`signOperatorRequest` / `verifyOperatorRequest` in
`packages/core/src/auth/operator-sign.ts`): headers `x-klaxon-operator-pub` (compressed secp256k1
hex), `x-klaxon-ts` (ISO-8601), `x-klaxon-operator-sig` (DER ECDSA-SHA256, base64url) over
`sha256("klaxon-operator-v1:" + METHOD + "\n" + path + "\n" + ts + "\n" + hex(sha256(body)))`.
Witness requires `pub == projects.operator_pubkey` and `|now − ts| ≤ 300 s`. The operator keypair is
generated at `klaxon init` and never leaves the laptop; `/projects` registers its public key
alongside `member_pubkey`.

> **This reverses D27**, which signed the admin surface with the LKRP member key. That key is a
> required input of `klaxon/get`, so it is present in the environment of every protected job —
> which made `POST /shares` a free share-B oracle for anything sharing that environment: no payment,
> no commitment, no HCS record. The domain string differs from the commitment's, so neither
> signature can be replayed as the other.

## 3. Share B derivation (D28)

`B = HKDF-SHA256(ikm = WITNESS_MASTER (32 B), salt = utf8("klaxon/b/v1"), info = utf8(project_id + "/" + secret + "/" + gen), 32)`.
The witness stores no B — only `(project, secret, gen, b_hash, retired)`. `emergency` recomputes it
from the paper-backed master.

**This is deterministic, and that has a protocol consequence.** Every release of the same
`(project, secret, gen)` returns byte-identical B, and share A in the repository does not change
within a generation. So the invariant the protocol delivers is *no **first** decryption without a
runner-authored, consensus-timestamped commitment*: a party that captured B during one legitimate
release can decrypt that generation offline afterwards, with no payment, no token and no record.
Rotating to `gen + 1` is what invalidates a captured B. `docs/CLAIM.md` and `docs/THREAT-MODEL.md`
state the bound in full.

## 4. Manifest — `GET /.well-known/klaxon.json`

```json
{ "klaxon": 1,
  "release_endpoint": "https://<witness>/release/{h}",
  "price": { "amount": "100000", "asset": "0.0.0", "network": "hedera:testnet" },
  "facilitator": "https://api.testnet.blocky402.com",
  "hedera_account": "0.0.<witness>",
  "submit_key": "<witness HCS submit public key, DER hex>",
  "memo_rule": "transaction memo MUST equal the commitment hash h",
  "projects": [ { "project_id": "…", "topic_id": "0.0.…", "policy_hash": "…", "current_gen": "3", "revoked": false } ],
  "verify": "git clone https://github.com/KaranSinghBisht/klaxon && cd klaxon && pnpm install && pnpm --filter @klaxon/verify dev --topic 0.0.… --witness 0.0.… --registry 0x…" }
```

**The `verify` string must be an invocation that actually runs.** Two things rule out the obvious
one: the `klaxon` CLI has **no `verify` subcommand** — its commands are `init`, `export-member`,
`policy commit`, `add`, `get`, `rotate`, `revoke`, `unrevoke`, `emergency`, and the verifier is a
separate binary, `klaxon-verify`, in `@klaxon/verify`; and **every package in this repository is
`"private": true`**, so nothing is on npm and `npx` resolves neither `klaxon` nor `klaxon-verify`.

From a clean checkout, both of these work today (`--json` for a machine-readable report):

```bash
pnpm install && pnpm --filter @klaxon/verify dev --topic 0.0.X --witness 0.0.Y --registry 0xREG
# or, built:
pnpm install && pnpm --filter @klaxon/verify build \
  && node packages/verify/dist/bin.js --topic 0.0.X --witness 0.0.Y --registry 0xREG
```

`--topic`, `--witness` and `--registry` are all required; the tool exits 2 with usage if any is
missing. `--since` takes a **Hedera consensus timestamp** (`seconds.nanos`, e.g. `1788848300.0`),
not a date — it becomes `timestamp=gte:<value>` on the mirror node.

## 5. x402 (Hedera, Blocky402)

- Server: `x402ResourceServer(HTTPFacilitatorClient({url: "https://api.testnet.blocky402.com"})).register("hedera:*", new ExactHederaScheme())`; `buildPaymentRequirements({scheme:"exact", network:"hedera:testnet", payTo, price:{amount:"100000", asset:"0.0.0"}, maxTimeoutSeconds:120, extra:{memo:h}})`. Price is an `AssetAmount` — a money string throws for HBAR.
- Client: custom `ClientHederaSigner.createPartiallySignedTransferTransaction(req)` builds the `TransferTransaction`, **`setTransactionMemo(req.extra.memo)`**, `setTransactionId(TransactionId.generate(req.extra.feePayer))`, freezes, signs with `KLAXON_PAY_KEY`, returns base64. `x402Client.fromConfig({schemes:[…], spendControls:{allowedAssets:[{network:"hedera:testnet", asset:"0.0.0", maxAmountPerPayment}]}, policies:[payTo === expected witness]})`.
- The fee payer on-chain is Blocky402's account; the runner is the debit in `transfers[]`. Verification binds on `transfers[]` + memo, never `payer_account_id`.
- Mirror-node tx id is dashed: `0.0.X@s.n` → `0.0.X-s-n`.

## 6. Witness release checks (in order; class on failure)

1. Payment settled on Hedera, read back from the mirror node: `result == SUCCESS`, `memo_base64 → h`, witness credited ≥ price, **the debit in `transfers[]` is the project's registered pay account** (when one is registered — this is what makes "the runner itself paid" enforceable rather than conventional), `consensus_timestamp` within 600 s, 3 retries @ 400 ms for mirror lag. *(auth; mirror down → infra)*
2. JWT: `iss == https://token.actions.githubusercontent.com`, `aud == "klaxon:"+h`, RS256, `clockTolerance` 60 s; `repository_id ∈ project`. *(auth; JWKS down → infra)*
3. `commitmentHash(C) == h`; `sig` valid; **`C.{repository_id, run_id, run_attempt, environment}` equal the JWT claims.** An absent `environment` claim matches only the sentinel `C.environment == "(none)"` — a request that *claims* an environment its token does not carry is the lying attack and fails here. *(auth)*
4. Policy: `raw.githubusercontent.com/{owner}/{repo}/{sha}/klaxon.policy.json`; `sha256(bytes) == policyHash[project]` on Sepolia; `C.environment ∈ policy.environments` — `"(none)"` never is, so **the honest worm in the install job is refused here, as `policy/4`, and revokes.** *(policy)*
5. Workflow at `sha` (`job_workflow_sha` for reusable; deny reusable workflows outside the project; refuse `event_name == pull_request`): in the job declaring this environment, no `run:` matches the 14-pattern install denylist (`packages/witness/src/lint/patterns.ts`) and every `uses:` is `owner/repo[/path]@<40-hex>`, `./local`, or `docker://…@sha256:<64-hex>`. An `environment:` that is a `${{ }}` expression is unresolvable and refuses. A parse or fetch failure is `infra`, never a pass. **This is a denylist over literal `run:` strings, not a sandbox**: it does not dereference composite actions and does not inspect downloaded artifacts — see `docs/THREAT-MODEL.md` § What check 5 actually is. *(policy)*
6. `C.secret ∈ policy.environments[env].secrets`; `C.gen == current_gen`; share row exists and not retired. *(policy)*
7. Releases for `(project, secret, gen)` < `max_releases` — **refuse without revoke**. *(policy, no revoke)*
8. Not revoked; local epoch == chain epoch. *(policy)*
9. `h` unused (unique). *(policy)*

Failure → `refused{class, check, reason}` to HCS + ntfy; **class policy revokes** (except check 7). Infra → 503, no HCS message, no revoke. Success → `released` to HCS via the outbox, **then** `share_b` returned.

## 7. HCS message envelope (one topic per project; submit key = 1-of-2 KeyList {witness, operator laptop})

`{"klaxon":1, "type":"released"|"refused"|"rotate"|"revoke"|"unrevoke"|"jwks"|"emergency", "ts":"<ISO>", "project_id":"…", ...}`

- `released`: `+ {h, C, jwt, sig, pay_tx}`
- `refused`: `+ {h, C, jwt, sig, pay_tx, class, check, reason}` (auth/policy only — infra never publishes)
- `rotate`: `+ {secret, from_gen, to_gen}` · `revoke`: `+ {reason, epoch}` · `unrevoke`: `+ {epoch, sepolia_tx}`
- `jwks`: `+ {keys:[…]}` (daily snapshot of GitHub's JWKS)
- `emergency`: `+ {h, secret, gen, pay_tx}` — published by the **operator's laptop key** (the second member of the topic's submit KeyList). Its commitment is `h = sha256(canonicalize({v:1, type:"emergency", project_id, secret, gen, ts}))`, paid on Hedera with memo `h` from the laptop's account before decrypting. `verify` pairs an `emergency` message with its payment exactly like a `released` (one per payment) and reports the count separately.

Messages > 1024 B are chunked by the SDK; readers group by `chunk_info.initial_transaction_id`, order by `number`, concatenate bytes, and use the **last chunk's** `consensus_timestamp`.

## 8. Sepolia — `KlaxonRegistry`

`register(bytes32 p)` · `commitPolicy(bytes32 p, bytes32 hash)` · `unrevoke(bytes32 p, uint64 epoch)` (monotonic). Events: `Registered`, `PolicyCommitted`, `Unrevoked`. Owner = the Ledger's address, set by `register`. Policy hash = `sha256(exact committed bytes of klaxon.policy.json)`. The witness polls `getLogs` with a persisted cursor (3 confirmations; 1 during the shoot).

**There is deliberately no `revoke()` and no `Revoked` event.** Revocation is *announced* on HCS
(`{type:"revoke", reason, epoch}`) and *enforced* from the witness's SQLite; only the clearing side is
on chain, because clearing is the half that must cost a device signature. The durability consequences
are in `docs/THREAT-MODEL.md` § Revocation is announced, not anchored — most importantly that a wiped
witness volume silently un-revokes.

## 9. `verify` pairing rules

Pair payments (memo = 64-hex, `result == SUCCESS`, net credit to the witness > 0) to messages by `pay_tx`: exactly one `released` per payment (any number of `refused`); a payment with neither after a 30 s grace → **`WITNESS WITHHELD`**; two `released` → `DOUBLE_RELEASE`; message consensus before payment consensus → `ORDERING`; incomplete chunk group → `MESSAGE_INCOMPLETE`; a `released` after a `revoke` and before the on-chain `Unrevoked` that clears it → `RELEASE_WHILE_REVOKED`. JWT `exp/nbf` evaluated at the **payment's** consensus time, live JWKS first then the newest `jwks` snapshot at or before it.

`verify` deliberately does **not** re-check the debit against a registered pay account: that account is
witness-held state, and a verifier that trusted it would be trusting the party it audits. Nor does
either side bind on `payer_account_id` — that is the facilitator's account (`docs/PAYMENT-FLOW.md`).
