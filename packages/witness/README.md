# `@klaxon/witness` — the release witness

The service that holds share B and refuses to hand it over unless a runner has **paid for a signed
commitment on Hedera** and that commitment survives nine checks. Every decision it makes — release
or refusal — is written to a Hedera Consensus Service topic that only the witness can write to and
anyone can read, *before* share B moves.

The invariant, in one line: **no decrypt without a runner-authored, consensus-timestamped
commitment the witness cannot omit or forge.**

The wire contract is [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md). This README covers running it.

---

## What it does

| Route | Auth | What happens |
|---|---|---|
| `GET /health` | none | `{ok, db, facilitator, mirror, sepolia_cursor_lag_s}`; **503** if any dependency is down |
| `GET /.well-known/klaxon.json` | none | manifest: price, facilitator, Hedera account, HCS submit key, projects |
| `GET /release/:h` | none | **402** with `PaymentRequirements.extra.memo == h` |
| `POST /release/:h` | x402 `PAYMENT-SIGNATURE` | the nine checks → **200** with `share_b`, **403** refusal (carrying `hcs` and `revoked`), or **503** infra |
| `POST /projects` `/shares` `/rotate` `/revoke` | member-signed | project registration and key lifecycle |

### The nine checks

1. **Payment** settled on Hedera: `SUCCESS`, memo decodes to `h`, witness credited ≥ price,
   consensus within `KLAXON_PAYMENT_MAX_AGE_S`. *(auth; mirror down → infra)*
2. **JWT** from GitHub's issuer, `aud == "klaxon:"+h`, RS256, `repository_id` belongs to the
   project. *(auth; JWKS down → infra)*
3. **Commitment integrity** — hash, signature, **and every GitHub-derived field of `C` compared
   against the token's own claims**. *(auth)*
4. **Policy** fetched at the token's `sha` and hashed against the anchor the Ledger signed into
   `KlaxonRegistry` on Sepolia, and `C.environment` is one the policy names. A job that declared
   no `environment:` commits to the `"(none)"` sentinel, which is never a policy environment — so
   this is where the worm is refused, and revoked. *(policy)*
5. **Workflow** at that commit: the job carrying this environment has no install step and only
   40-hex-pinned `uses:`. Refuses `pull_request` and reusable workflows outside the project.
   *(policy)*
6. **Secret and generation** are the ones the policy allows and the ones currently in force.
   *(policy)*
7. **Budget** — releases for `(project, secret, gen)` within `max_releases`.
   *(policy, **never revokes** — it is a rate limit, not an attack signal)*
8. **Not revoked**, and the local epoch matches the chain epoch. *(policy)*
9. **`h` unused** — the primary key on `releases.h` is what makes a commitment single-use.
   *(policy)*

A `policy` refusal revokes the project (except check 7); an `auth` refusal does not. **`infra`
never revokes and never publishes** — a mirror-node timeout must not cost anyone their project.

### Check 3 is the one that matters

A runner can ask GitHub for a token with *any* audience it likes. So `aud == "klaxon:" + h` proves
only that some job asked for that audience — it says nothing about whether `C` describes that job.
A malicious install-phase job can claim `environment: "production"` in `C`, hold a token whose real
`environment` claim is absent, and the audience will still match perfectly.

`src/checks/c3-commitment.ts` is where that attack dies: every GitHub-derived field of `C` must
equal the token's own claim, with an absent `environment` claim matching the `"(none)"` sentinel
exactly. Without those lines the entire commitment binding is decorative. The file says so, at
length, on purpose.

Note what check 3 does *not* do: it catches the lie, not the absence. A worm that honestly commits
to `"(none)"` passes here — it really did run in a job with no environment — and is refused by
check 4 as `policy`, which is what revokes the project. Classifying the honest case as `auth` would
have meant the demo's central refusal did not revoke anything.

---

## Running it locally

```bash
cp packages/witness/.env.example packages/witness/.env   # then fill in the four secrets
pnpm --filter @klaxon/witness dev                        # tsx src/main.ts
```

Node 22 works (`node:sqlite` prints an `ExperimentalWarning`); the image runs Node 24, where it is
stable. Boot fails loudly and immediately if the facilitator's `/supported` cannot be reached — a
witness that cannot settle must not serve a 402 it cannot honour.

```bash
pnpm exec vitest run packages/witness                        # no network, fakes for every port
pnpm exec tsc --noEmit -p packages/witness/tsconfig.json     # sources
pnpm exec tsc --noEmit -p packages/witness/tsconfig.test.json # sources + tests
```

## Environment

Every value is read from `process.env` and validated by `src/env.ts`; a missing required variable
throws before the first request. See `.env.example` for the full list. The four that are secret:

| Variable | Why it matters |
|---|---|
| `WITNESS_MASTER` | 32 bytes. **Every** share B is derived from it. Back it up on paper before the first `klaxon add` — losing it makes every protected secret undecryptable, and `klaxon emergency` needs it. |
| `HEDERA_OPERATOR_KEY` | Signs HCS submits and owns the payee account. |
| `NTFY_DEFAULT_TOPIC` | ntfy topics are public: the topic name *is* the password. Use `klaxon-<32 hex>`. |
| `GITHUB_TOKEN` | Only when `KLAXON_SOURCE=api` (private repositories). The default `raw` path needs no token at all. |

## Deploying

```bash
fly launch --no-deploy --name klaxon-witness --region iad
fly volumes create klaxon_data --region iad --size 1
fly secrets set WITNESS_MASTER=… HEDERA_OPERATOR_ID=… HEDERA_OPERATOR_KEY=… NTFY_DEFAULT_TOPIC=…
fly deploy
```

One machine, `auto_stop_machines = false`, `min_machines_running = 1`. A stopped machine misses
Sepolia blocks and adds a cold start to the release path, and SQLite on a Fly volume is
single-attach, so a second machine would silently diverge.

## Design notes worth knowing before changing anything

**Share B is derived, never stored.**
`B = HKDF-SHA256(WITNESS_MASTER, salt="klaxon/b/v1", info=project_id/secret/gen, 32)`. The database
holds `(project, secret, gen, b_hash, retired)` and no ciphertext. A stolen witness disk is worth
nothing without the master, and recovery needs no witness state at all.

**Publish, then answer.** The HCS submit is on the critical path by design: the record reaches
consensus *before* share B moves, and before a refusal is answered — which is why a 403 can carry
`hcs.sequence_number` and the caller can print "on the record: HCS #N". Anything that answers
earlier is a bug, not an optimisation.

**The outbox is not optional.** The decision and the intent to publish are one atomic write. Without
it, a crash between the two leaves a settled payment with no message — and `verify` would correctly
report `WITNESS WITHHELD` against an honest witness.

**Retries are idempotent, replays are not.** Same `h` + same `pay_tx` + same `C` re-seals B from the
same inputs and publishes nothing new. Same `h` under a *different* payment is a replay: refused at
check 9. One payment, exactly one `released`.

**Everything external is a port.** `PaymentPort`, `HcsPort`, `RegistryPort`, `SourcePort`,
`OidcPort`, `AlarmPort`, `Clock`. The test suite runs the real server over fakes and an in-memory
database, including a fake GitHub OIDC issuer that mints deliberately hostile tokens.

## Honest limitations

- **Liveness depends on other people's services.** A release needs Blocky402 to settle, Hedera to
  reach consensus, GitHub to serve the policy and workflow, and Sepolia to have been read recently
  enough for `/health` to stay green. Any of them being down stops releases — correctly, as `infra`
  with a 503, but it stops them. On the client side the runner also needs Ledger's trustchain API
  to decrypt share A, so **Ledger's backend is a liveness dependency of every release**, not merely
  a trust one. `klaxon emergency` is the documented way out.
- **The JWKS snapshot is witness-authored.** `verify` falls back to it when a token's `kid` has
  rotated out of GitHub's live keyset, so an old token is only as trustworthy as the witness was on
  the day it published that snapshot — before it knew which tokens it might later want to forge.
  Bounded, and better said plainly than hand-waved.
- **Rotation does not un-leak a secret.** It makes a captured share A inert, which is why `rotate`
  demands the *new* upstream value: the credential itself has to be replaced.
- **The manifest lists every tenant.** Fine for a single-tenant demo; `?project=` exists for
  deployments where it is not.
- **`node:sqlite` is experimental on Node 22.** The image pins Node 24, where it is not.
