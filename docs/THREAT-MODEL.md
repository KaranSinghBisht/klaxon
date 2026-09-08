# Threat model

The attacker we design against, the two properties we deliver, and — stated with the same precision — what is out of scope. `docs/CLAIM.md` is the one-paragraph version; this is the engineering one.

## Attacker capabilities (in scope)

- Arbitrary code execution on any CI runner, via a malicious dependency, build plugin, or compromised action.
- Read access to that runner's environment, filesystem, and process memory; outbound network.
- Possession of everything that runner holds: `KLAXON_MEMBER` (the Key Ring member credential) and `KLAXON_PAY_KEY` (a Hedera account holding a few ℏ). **Assume both leak.**
- A stolen GitHub session (covered by the on-chain `unrevoke` path, which only the Ledger can sign).
- Compromise of the **witness alone** — its host, its database, its master key.
- A *past* runner compromise combined with a *later* witness compromise (disclosed and mitigated below).

## Two properties, two mechanisms

| Property | Mechanism | Holds against |
|---|---|---|
| **No single party can decrypt.** | `DK = A ⊕ B`. A is encrypted under the operator's Ledger Key Ring and lives in git; B is derived by the witness from its master and only ever released into an envelope sealed to a runner-generated ephemeral key. | Runner alone (has A; must pay for B — logged). Witness alone (has B, or the master that yields it; never A). Git alone (ciphertext, no credential, no B). |
| **Every release is on a ledger the witness did not write.** | The runner pays on Hedera with the commitment hash as memo *before* the witness will act. `klaxon verify` flags any payment with no matching witness message as `WITNESS WITHHELD`. | Witness omission — it cannot delete a record it never authored. |
| **The commitment cannot be forged or replayed.** | The OIDC token's `aud` is `klaxon:<h>`; `h` covers `{project, secret, gen, repository_id, run, attempt, environment, ephemeral keys}`; the witness cross-checks every GitHub-derived field in `C` against the token's own claims (an `aud` alone is attacker-chosen); release requires a signature by the ephemeral key; `h` is single-use. | Field substitution by a compromised witness; JWT replay from another runner; cross-project replay. |
| **Policy cannot be swapped.** | The policy hash is device-signed onto Sepolia; the witness reads the policy file from the repo at the token's `sha` and refuses on mismatch. | A witness serving a looser policy. |
| **Job identity is enforced, not declared.** | The witness fetches the workflow at the token's `sha` and refuses any environment-bearing job that installs packages or uses an unpinned action. | A stolen session adding `environment:` to a job that runs `npm ci`. |
| **Rotation actually invalidates.** | `rotate` re-splits under generation N+1 and replaces the upstream credential; the witness serves B only for the current generation. | A share A captured under generation N. |

## Disclosed and bounded

- **After a legitimate release, code inside that authorized job can read the secret.** The record names the secret, environment, and run. You rotate that one — not sixty. This is blast-radius scoping, not prevention, and it is the product.
- **Captured ciphertext + leaked credential** decrypts A on a later run without a new commitment. Credential leak *alone* does not bypass the log; credential plus captured ciphertext does — until `rotate`. Rotation is mandated on every policy alarm.
- **Non-simultaneous runner + witness compromise:** a member credential leaked on day 1 plus a witness compromise on day 30 yields B for every generation that still exists. Mitigation is generation rotation after any runner compromise; re-keying the trustchain (`ring destroy` + `ring init`) needs the physical device — that is a feature.
- **Ledger's Key Ring backend is a liveness dependency.** `restoreTrustchain` calls `trustchain.api.live.ledger.com` on every release. If it is unreachable, the runner fails closed *before* paying — no commitment is made, nothing to refuse. `emergency` needs it too. The floor is `ring init` recovery on the device.
- **The witness is a liveness dependency**, not a confidentiality one. Down → deploys block (fail closed). Infrastructure failures alarm but never revoke; only policy violations revoke.
- **The fee payer on the x402 path is the facilitator (Blocky402).** The runner signs the frozen transaction body — including the memo — and funds the value transfer; the facilitator sponsors the network fee. `verify` binds "the runner paid" on the debit in `transfers[]` and the payer signature, never on `payer_account_id`.
- **Old tokens and rotated JWKS.** `verify` validates recent tokens against GitHub's live keys and older ones against `jwks` snapshots the witness published to HCS daily. A snapshot is witness-authored: an old token is only as trustworthy as the witness *was on the day it published that snapshot* — before it could know which tokens it would later want to forge.

## Out of scope

Simultaneous compromise of a runner **and** the witness; Hedera consensus; the operator's laptop during `init`, `add`, `rotate`, or `export-member`; a GitHub session with admin rights that also rewrites environment protection rules (GitHub's control — KLAXON assumes it is on); the mainnet deployer key, which should live in a Safe with signers on Ledgers, not in CI — KLAXON's own docs say so.
