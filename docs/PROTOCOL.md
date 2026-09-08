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
| `GET /health` | none | `{ok, db, facilitator, mirror, sepolia_cursor_lag_s}`; 503 if any check fails |
| `GET /.well-known/klaxon.json` | none | manifest (§4) |
| `GET /release/:h` | none | **402** with x402 `PAYMENT-REQUIRED` header; `PaymentRequirements.extra.memo == h` |
| `POST /release/:h` | x402 `PAYMENT-SIGNATURE` header | body `{C, jwt, sig}` (`ReleaseRequestBody`) → **200** `ReleaseOk` \| **403** `ReleaseRefused` (auth/policy) \| **503** `ReleaseRefused{class:"infra"}` |
| `POST /projects` | member-signed | `{project_id, repository_id, repository, member_pubkey, topic_id, ntfy_topic}` → `{ok:true}` |
| `POST /shares` | member-signed | `{project_id, secret, gen}` → `{ok:true, b: b64u(32), b_hash}` — witness **derives** B (§3) and records `(project, secret, gen, b_hash)`; first write wins |
| `POST /rotate` | member-signed | `{project_id, secret, gen}` (new gen, must be current+1) → same as `/shares`; retires the previous gen |
| `POST /revoke` | member-signed | `{project_id, reason}` → `{ok:true, epoch}` |

`ReleaseOk = {ok:true, h, share_b: EciesEnvelope, hcs:{sequence_number, consensus_timestamp}}`
`ReleaseRefused = {ok:false, h, class:"auth"|"policy"|"infra", check: 0..9, reason}`

The witness learns `pay_tx` from x402 settlement (`settle.transaction`); the body never carries it.
The client reads it back from the `PAYMENT-RESPONSE` header.

**Member-signed requests** (`signMemberRequest` / `verifyMemberRequest` in core): headers
`x-klaxon-member-pub` (compressed secp256k1 hex), `x-klaxon-ts` (ISO-8601), `x-klaxon-member-sig`
(DER ECDSA-SHA256, base64url) over
`sha256("klaxon-member-v1:" + METHOD + "\n" + path + "\n" + ts + "\n" + hex(sha256(body)))`.
Witness requires `pub == projects.member_pubkey` and `|now − ts| ≤ 300 s`.

## 3. Share B derivation (D28)

`B = HKDF-SHA256(ikm = WITNESS_MASTER (32 B), salt = utf8("klaxon/b/v1"), info = utf8(project_id + "/" + secret + "/" + gen), 32)`.
The witness stores no B. `emergency` recomputes it from the paper-backed master.

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
  "verify": "npx klaxon verify --topic 0.0.… --witness 0.0.… --registry 0x…" }
```

## 5. x402 (Hedera, Blocky402)

- Server: `x402ResourceServer(HTTPFacilitatorClient({url: "https://api.testnet.blocky402.com"})).register("hedera:*", new ExactHederaScheme())`; `buildPaymentRequirements({scheme:"exact", network:"hedera:testnet", payTo, price:{amount:"100000", asset:"0.0.0"}, maxTimeoutSeconds:120, extra:{memo:h}})`. Price is an `AssetAmount` — a money string throws for HBAR.
- Client: custom `ClientHederaSigner.createPartiallySignedTransferTransaction(req)` builds the `TransferTransaction`, **`setTransactionMemo(req.extra.memo)`**, `setTransactionId(TransactionId.generate(req.extra.feePayer))`, freezes, signs with `KLAXON_PAY_KEY`, returns base64. `x402Client.fromConfig({schemes:[…], spendControls:{allowedAssets:[{network:"hedera:testnet", asset:"0.0.0", maxAmountPerPayment}]}, policies:[payTo === expected witness]})`.
- The fee payer on-chain is Blocky402's account; the runner is the debit in `transfers[]`. Verification binds on `transfers[]` + memo, never `payer_account_id`.
- Mirror-node tx id is dashed: `0.0.X@s.n` → `0.0.X-s-n`.

## 6. Witness release checks (in order; class on failure)

1. Payment settled on Hedera: `result == SUCCESS`, `memo_base64 → h`, witness credited ≥ price, `consensus_timestamp` within 600 s, 3 retries @ 400 ms for mirror lag. *(auth; mirror down → infra)*
2. JWT: `iss == https://token.actions.githubusercontent.com`, `aud == "klaxon:"+h`, RS256, `clockTolerance` 60 s; `repository_id ∈ project`. *(auth; JWKS down → infra)*
3. `commitmentHash(C) == h`; `sig` valid; **`C.{repository_id, run_id, run_attempt, environment}` equal the JWT claims.** An absent `environment` claim matches only the sentinel `C.environment == "(none)"` — a request that *claims* an environment its token does not carry is the lying attack and fails here. *(auth)*
4. Policy: `raw.githubusercontent.com/{owner}/{repo}/{sha}/klaxon.policy.json`; `sha256(bytes) == policyHash[project]` on Sepolia; `C.environment ∈ policy.environments` — `"(none)"` never is, so **the honest worm in the install job is refused here, as `policy/4`, and revokes.** *(policy)*
5. Workflow at `sha` (`job_workflow_sha` for reusable; deny reusable workflows outside the project; refuse `event_name == pull_request`): the job with this environment has no install step and only 40-hex-pinned `uses:`. *(policy)*
6. `C.secret ∈ policy.environments[env].secrets`; `C.gen == current_gen`; share row exists and not retired. *(policy)*
7. Releases for `(project, secret, gen)` < `max_releases` — **refuse without revoke**. *(policy, no revoke)*
8. Not revoked; local epoch == chain epoch. *(policy)*
9. `h` unused (unique). *(policy)*

Failure → `refused{class, check, reason}` to HCS + ntfy; **class policy revokes** (except check 7). Infra → 503, no HCS message, no revoke. Success → `released` to HCS via the outbox, **then** `share_b` returned.

## 7. HCS message envelope (one topic per project; submit key = witness)

`{"klaxon":1, "type":"released"|"refused"|"rotate"|"revoke"|"unrevoke"|"jwks"|"emergency", "ts":"<ISO>", "project_id":"…", ...}`

- `released`: `+ {h, C, jwt, sig, pay_tx}`
- `refused`: `+ {h, C, jwt, sig, pay_tx, class, check, reason}` (auth/policy only — infra never publishes)
- `rotate`: `+ {secret, from_gen, to_gen}` · `revoke`: `+ {reason, epoch}` · `unrevoke`: `+ {epoch, sepolia_tx}`
- `jwks`: `+ {keys:[…]}` (daily snapshot of GitHub's JWKS) · `emergency`: `+ {secret, gen, pay_tx}` (published by the operator's laptop key)

Messages > 1024 B are chunked by the SDK; readers group by `chunk_info.initial_transaction_id`, order by `number`, concatenate bytes, and use the **last chunk's** `consensus_timestamp`.

## 8. Sepolia — `KlaxonRegistry`

`register(bytes32 p)` · `commitPolicy(bytes32 p, bytes32 hash)` · `unrevoke(bytes32 p, uint64 epoch)` (monotonic). Owner = the Ledger's address, set by `register`. Policy hash = `sha256(exact committed bytes of klaxon.policy.json)`. The witness polls `getLogs` with a persisted cursor (3 confirmations; 1 during the shoot).

## 9. `verify` pairing rules

Pair payments (memo = 64-hex) to messages by `pay_tx`: exactly one `released` per payment (any number of `refused`); a payment with neither after a 30 s grace → **`WITNESS WITHHELD`**; two `released` → `DOUBLE_RELEASE`; message consensus before payment consensus → `ORDERING`; incomplete chunk group → `MESSAGE_INCOMPLETE`. JWT `exp/nbf` evaluated at the **payment's** consensus time, live JWKS first then the newest `jwks` snapshot at or before it.
