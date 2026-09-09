# KLAXON

> **Stolen, but never quietly.**

Your CI secrets are split in two. Share A is encrypted under your **Ledger Key Ring** and lives in
your repo. Share B is released by a witness only when **the runner itself has paid on Hedera** — a
sub-cent x402 payment whose memo is the hash of a signed release commitment naming the secret, the
environment, the run, and an ephemeral key only that runner holds. Neither share is useful alone.

**No secret can be decrypted for the first time without a commitment the runner wrote to a public
ledger first.** The witness can't omit it — the runner authored it. The witness can't forge it — it
needs GitHub's signature and the runner's. Nobody can back-date it — Hedera consensus timestamps it.
When a supply-chain worm tries, it *pays to be refused*.

## Status — read this first

This is a five-day hackathon build (ETHOnline 2026). As of **2026-09-09**:

- **No physical Ledger has been connected.** No `ring init`, no device signature, no trustchain.
  Gate A (`scripts/gate-a.sh`) has not run, and `packages/core/test/wallet-cli-interop.test.ts` is
  skipped for that reason.
- **Nothing is deployed on any chain.** `packages/contracts/` has no `broadcast/` directory. No
  ERC-7730 descriptor has been filed.
- The one piece of captured runtime evidence is `docs/evidence/oidc-probe.json` — a real GitHub
  Actions OIDC token's claims.
- Every device-dependent statement in `docs/LEDGER-FEEDBACK.md` is marked *pending Gate A*.

The protocol, the nine witness checks, the independent verifier and the crypto are implemented and
unit-tested. The hardware and on-chain halves are not yet exercised. This section is the honest
boundary between the two, and it is the first thing to check against when reading anything else here.

## Why

In H1 2026, infrastructure and operational compromises accounted for **~76% of all crypto funds
stolen** from only **~15% of incidents** — the losses are not smart-contract bugs, they are stolen
credentials. Shai-Hulud 2.0 hit **~700 npm packages** in November 2025 and spawned **25,000+
malicious repositories**; the same campaign's leaked API key was used to publish a trojanized Trust
Wallet extension that drained **$8.5M**. Every statistic here is sourced in
[`docs/SOURCES.md`](docs/SOURCES.md).

The industry answer is short-lived, identity-bound credentials — OIDC to AWS, npm trusted publishing,
Vault's JWT auth. That works, and where it exists you should use it. It does not exist for the sixty
other tokens in a real pipeline: an Etherscan key, a Vercel token, a deployer private key. Those are
long-lived strings in a CI environment, and when one is read there is no record that it happened.

KLAXON does not try to stop a compromised job from reading a secret it was authorized to receive. It
makes the *first* read impossible to perform silently, and it names exactly what was read.

## The claim, stated precisely

What KLAXON **guarantees**: no secret is released for the first time without a release commitment
that (1) the runner itself paid to place on Hedera, (2) names the secret, environment, run and an
ephemeral key only that runner holds, and (3) reached consensus before share B moved.

What KLAXON **does not** do: prevent a compromised authorized job from reading what it was authorized
to receive; stop an attacker replaying a share B it already captured; survive simultaneous compromise
of a runner *and* the witness.

**The word *first* is load-bearing.** Share B is derived, not random —
`B = HKDF(WITNESS_MASTER, "klaxon/b/v1", project_id/secret/gen)` — so every release of a generation
returns the same 32 bytes, and share A in git does not change within a generation. Anything that
captures both once can decrypt that generation offline from then on: no payment, no token, no record.
One observed release under a compromised runner is full compromise of that generation, and rotating
to `gen + 1` with a genuinely new upstream credential is the only remediation.

Full statement: [`docs/CLAIM.md`](docs/CLAIM.md). Engineering version, including what the workflow
lint does and does not catch and why revocation is announced rather than anchored:
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Payment flow

The witness's `POST /release/:h` is a live x402-gated service on Hedera, settled through the
**Blocky402** facilitator. The GitHub Action is the platform that consumes it. **The payment is not a
fee for a proof — it is the release commitment itself.**

1. The runner builds the commitment `C`, hashes it to `h`, and mints an OIDC token with
   `aud = klaxon:<h>`.
2. `POST /release/:h` answers **402** with x402 `PaymentRequirements`: `network: hedera:testnet`,
   `payTo: <witness>`, `price: {amount: "100000", asset: "0.0.0"}` (0.001 ℏ), and **`extra.memo = h`**.
3. Stock x402 has no memo concept, so the action uses a custom `ClientHederaSigner`: it builds the
   `TransferTransaction`, calls **`setTransactionMemo(h)`**, sets the facilitator as fee payer,
   freezes, and signs with `KLAXON_PAY_KEY`.
4. The witness calls Blocky402 `/verify` then `/settle`. The facilitator adds its fee-payer signature
   and submits — it cannot alter the memo, which is inside the body the runner signed.
5. The witness reads the settled transaction back from the **mirror node** and requires
   `result == SUCCESS`, the memo to decode to `h`, itself credited ≥ price, the debit to be the
   project's registered pay account, and the timestamp to be fresh. Then eight more checks.
6. On success a `released` message carrying `pay_tx` is published to the project's HCS topic
   **before** share B is returned.

Roughly 7–10 s per release. `klaxon-verify` reads every payment to the witness account from the
public mirror node and flags any with no matching message as **`WITNESS WITHHELD`** — the witness
cannot omit a Hedera transfer it did not author. Detail, including exactly what each side binds on
and why neither binds on `payer_account_id`: [`docs/PAYMENT-FLOW.md`](docs/PAYMENT-FLOW.md).

## Quickstart

Requires Node ≥ 22 and pnpm 11.

```bash
git clone https://github.com/KaranSinghBisht/klaxon && cd klaxon
pnpm install          # needs the stub override in pnpm-workspace.yaml — see docs/LEDGER-FEEDBACK.md §5
pnpm test             # unit tests; the wallet-cli interop test is skipped without a device
pnpm build && pnpm typecheck && pnpm lint
```

Setting up a protected repository — this is the intended sequence, and steps 1 and 3 need the Ledger:

```bash
klaxon init --repository ORG/REPO --repository-id 123456789 \
            --witness https://your-witness --registry 0xREG   # ring init, HCS topic, register on Sepolia
klaxon export-member                                          # → secrets.KLAXON_MEMBER (printed once)
printf '%s' "$VALUE" | klaxon add DEPLOYER_PRIVATE_KEY        # → .klaxon/DEPLOYER_PRIVATE_KEY.enc, committed
klaxon policy commit                                          # device-signs the policy hash onto Sepolia
```

Then in the workflow — note the split between an install job and the environment-bearing job that
holds no install step, which the witness enforces:

```yaml
deploy:
  needs: build
  environment: production
  permissions: { id-token: write, contents: read }
  steps:
    - uses: actions/checkout@<40-hex>          # the action reads .klaxon/<NAME>.enc from the checkout
    - uses: actions/download-artifact@<40-hex>
    - id: klaxon
      uses: KaranSinghBisht/klaxon/packages/action@<40-hex>
      with:
        secret: DEPLOYER_PRIVATE_KEY
        member: ${{ secrets.KLAXON_MEMBER }}
        pay-account: ${{ vars.KLAXON_PAY_ACCOUNT }}
        pay-key: ${{ secrets.KLAXON_PAY_KEY }}
    - run: forge script script/Deploy.s.sol --broadcast
      env: { DEPLOYER_PRIVATE_KEY: "${{ steps.klaxon.outputs.value }}" }
```

Per-repo checklist, including what the split job pattern does and does not buy you:
[`docs/MIGRATION.md`](docs/MIGRATION.md). Runbook: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Verify it yourself

`klaxon-verify` re-derives the entire release history from public data — the Hedera mirror node, the
project's HCS topic, and Sepolia. **It never talks to the witness**, and it shares no code with it:
`@klaxon/verify` has a zero-line dependency on `@klaxon/core` and reimplements JCS canonicalization,
hashing and the JWT path independently, so "it doesn't trust me" is literally true.

Every package here is `"private": true`, so `npx` resolves nothing, and there is no `klaxon verify`
subcommand — the verifier is a separate binary. From a clean checkout, on any machine:

```bash
git clone https://github.com/KaranSinghBisht/klaxon && cd klaxon && pnpm install
pnpm --filter @klaxon/verify dev --topic 0.0.X --witness 0.0.Y --registry 0xREG
```

`--topic`, `--witness` and `--registry` are all required. Add `--json` for a machine-readable report.
Exit codes: `0` clean, `1` violations found, `2` the read could not complete. `--since` takes a Hedera
consensus timestamp (`seconds.nanos`), not a date.

It reports `WITNESS WITHHELD` (a payment with no message), `DOUBLE_RELEASE`, `ORDERING`,
`MESSAGE_INCOMPLETE` and `RELEASE_WHILE_REVOKED`, checks every JWT against the keys that were live at
the *payment's* consensus time, and checks the policy against the hash anchored on Sepolia.

## Prior work & disclosure

KLAXON's invariant — *a public, unforgeable record as a precondition of decryption* — is not new. What
is new, as far as we can find, is applying it to CI secret release with the record authored by the
consumer and the gate rooted in a hardware wallet. Everything below was checked against its source on
2026-09-09; where our earlier notes were wrong, the correction is stated.

**The same invariant, formalised**
- **Fialka** — *An Accountable Decryption System Based on Privacy-Preserving Smart Contracts*, Li,
  Wang, Liu, Wang & Galindo, **ISC 2020** (LNCS 12472, pp. 372–390),
  [doi](https://doi.org/10.1007/978-3-030-62974-8_21) ·
  [open PDF](https://zenodo.org/records/4556922). A privacy-preserving smart contract is both key
  manager and transparent judge, so a lawful-interception decryption cannot happen without leaving a
  public record. *Difference:* Fialka makes a **third party's** decryption of *someone else's* data
  accountable to a court; KLAXON makes the secret's own legitimate consumer author the record about
  itself. Follow-up, TEE-assisted and formalised: [ePrint 2023/1519](https://eprint.iacr.org/2023/1519)
  (preprint only — no peer-reviewed venue found).
- **Google Cloud Key Access Justifications**
  ([docs](https://docs.cloud.google.com/assured-workloads/key-access-justifications/docs/overview)) —
  the closest deployed system: every key use emits a machine-readable justification that the
  customer's external key manager records and can **deny** on. *Difference:* the record is private,
  enterprise-scoped, and written by the party requesting access to *someone else's* key; KLAXON's is
  public, permissionless, consensus-timestamped, and written by the party about to use its own secret.

**Ledger building the same half — this is our substrate, not a competitor**
- **`wallet-cli ring`** (LKRP secret encrypt/decrypt): shipped in wallet-cli 2.0.0 via
  [PR #19477](https://github.com/LedgerHQ/ledger-live/pull/19477) (merged 2026-07-10). The explicitly
  agentic/CI framing — a section headed *"Password injection without a TTY (agentic / CI)"* — is in
  the earlier, **closed** [#16859](https://github.com/LedgerHQ/ledger-live/pull/16859);
  [#17743](https://github.com/LedgerHQ/ledger-live/pull/17743) is also closed. *Difference:* `ring`
  gives hardware-rooted, recoverable encryption of a repo-committed file, gated on trustchain
  membership alone and leaving **no public trace**. KLAXON adds the commitment that makes the first
  decryption observable. Our feedback to Ledger, including a bug in shipped code, is in
  [`docs/LEDGER-FEEDBACK.md`](docs/LEDGER-FEEDBACK.md).

**Encrypted secrets in the repo, gated on identity**
- **DMNO PKP secrets** — [ETHGlobal SF 2024](https://ethglobal.com/showcase/dmno-pkp-secrets-vaytr),
  [repo](https://github.com/dmno-dev/ethsf-2024). An encrypted secrets file committed to the repo, a
  Lit PKP for encryption, decryption gated on GitHub org team membership with the ACL as a Sign
  Protocol attestation. *Difference:* gates on **who you are**, checked privately, with no public
  artifact per decryption. Honest caveat: this was a hackathon prototype and **never shipped** — the
  DMNO plugin actually [documented today](https://dmno.dev/docs/plugins/encrypted-vault/) is a
  symmetric-key vault with a hand-shared key.
- **Lit Actions access control conditions**
  ([docs](https://developer.litprotocol.com/sdk/access-control/intro),
  [blog](https://spark.litprotocol.com/using-lit-actions-for-access-control/)) — a ciphertext's access
  condition names a Lit Action by IPFS CID, so it decrypts only inside that exact code. *Difference:*
  gates on **code identity**, decided by a private threshold-node vote that leaves no public record.
  Lit answers "is the right code asking?"; KLAXON answers "did the world get told?". *Correction to an
  earlier note of ours:* there is no official Lit product called "Lit Secrets" — that name belongs to
  an [ETHGlobal Bangkok 2024 project](https://ethglobal.com/showcase/lit-secrets-a3pxh) later adopted
  into Lit's GitHub org.

**OIDC to ephemeral key to public log**
- **Sigstore Fulcio + Rekor** ([Fulcio](https://docs.sigstore.dev/certificate_authority/overview/),
  [Rekor](https://docs.sigstore.dev/logging/overview/)) — OIDC identity → ~10-minute ephemeral
  certificate → append-only public transparency log; the key is discarded and trust comes from the
  log. Structurally the closest thing to KLAXON's commitment. *Difference:* Rekor logs **signing**,
  not **access**, and it is written *after* an act that already succeeded. It is a record, not a
  precondition. KLAXON inverts the arrow: no record, no plaintext.

**Preventing the exfiltration KLAXON records**
- **StepSecurity Harden-Runner** ([repo](https://github.com/step-security/harden-runner)) — egress
  filtering and blocking for GitHub Actions runners, free for public repositories on GitHub-hosted
  runners, with `egress-policy: block` and a domain allowlist. *Difference:* it tries to stop the
  secret **leaving**; KLAXON assumes the perimeter fails and makes the secret's first use impossible
  to perform quietly. The two compose, and you should probably run both. Precision note: the free
  community agent enforces at DNS/L3-L4 (DNS proxy + iptables); the eBPF path is Enterprise/ARC. Its
  community-tier blocking has been bypassed repeatedly — CVE-2026-32947 (DNS-over-HTTPS),
  CVE-2026-32946 (DNS-over-TCP), CVE-2026-25598, CVE-2025-32955.

**The industry default we are competing with**
- **HashiCorp Vault + GitHub OIDC/JWT auth**
  ([docs](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-hashicorp-vault)),
  and **GitHub OIDC → AWS/GCP workload identity federation**. Short-lived, identity-bound CI
  credentials — genuinely the right answer wherever the destination speaks OIDC. *Difference:* the
  audit log is private, operator-controlled and mutable by the operator, and neither covers a secret
  whose destination has no OIDC path. KLAXON is for those.
- Also adjacent, in one line each: **Mozilla SOPS / age / git-crypt** — the same shape as share A
  (encrypted secret in the repo) with no gate and no record; **AWS KMS + CloudTrail** — every
  `Decrypt` is logged, but after the fact, privately, and mutably by the account owner;
  **[Threshold TACo](https://docs.taco.build/)** — on-chain conditions are *checked*, not *published*;
  **[drand / tlock](https://github.com/drand/tlock)** — the precondition is the passage of time, not
  an act by the decryptor.

**Disclosure.** Nothing in this repository was reused from any prior project. It was built with
Claude Code as the primary engineering assistant under human direction, with one cold review from
OpenAI Codex; the full account, including what has *not* happened yet, is in
[`docs/AI-USAGE.md`](docs/AI-USAGE.md). Commit history is unsquashed and every commit names the model
that wrote it. The nine adversarial reviews in `planning/simulated-review/` are **simulations by AI
personas, not real judge feedback**.

## Repository

| Path | What |
|---|---|
| `packages/core` | canonicalization, hashing, AEAD, XOR split, ECIES, ephemeral keys, LKRP domain key, operator signing |
| `packages/cli` | `klaxon` — `init`, `export-member`, `policy commit`, `add`, `get`, `rotate`, `revoke`, `unrevoke`, `emergency` |
| `packages/witness` | Fastify + `node:sqlite`; nine release checks, HCS outbox, Sepolia watcher, ntfy alarm |
| `packages/verify` | `klaxon-verify` — independent verifier, zero dependency on core |
| `packages/action` | the Node 24 GitHub Action that pays and consumes the release |
| `packages/contracts` | `KlaxonRegistry` (Foundry) + the ERC-7730 descriptor |
| `docs/` | claim · threat model · protocol · payment flow · operations · migration · Ledger feedback · AI usage · sources |
| `planning/` | spec v1–v3, build plan and decision register, nine adversarial reviews |

Built for ETHOnline 2026. Apache-2.0.
