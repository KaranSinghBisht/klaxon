# Payment flow

KLAXON hosts a live x402-gated service on Hedera — the witness's `POST /release/:h` — settled through
the **Blocky402** facilitator, and the GitHub Action is the platform that consumes it. One sub-cent
HBAR payment per secret release. The payment is not a fee for a proof: **it is the release commitment
itself.**

## The sequence

1. The runner builds the commitment `C` (secret, environment, run, ephemeral keys), hashes it to `h`,
   and mints an OIDC token with `aud = klaxon:<h>`.
2. `POST /release/:h` → the witness answers **402** with x402 `PaymentRequirements`:
   `network: hedera:testnet`, `payTo: <witness account>`, `price: { amount: "100000", asset: "0.0.0" }`
   (0.001 ℏ, native HBAR — an `AssetAmount`, because HBAR cannot be priced with a money string),
   `maxTimeoutSeconds: 120`, and **`extra.memo = h`**.
3. The action's x402 client hands the requirements to a **custom `ClientHederaSigner`**. Stock x402
   has no memo concept; ours builds the `TransferTransaction` (debit runner, credit witness), calls
   **`setTransactionMemo(h)`**, sets the facilitator as fee payer (`extra.feePayer` — the witness
   reads it from Blocky402 `/supported` at boot rather than hardcoding it; on testnet today it is
   `0.0.7162784`), freezes, signs
   with `KLAXON_PAY_KEY`, and returns it base64 in the `PAYMENT-SIGNATURE` header. Spend controls
   allow only `hedera:testnet` / asset `0.0.0` up to `max-tinybars`, and a policy refuses any `payTo`
   other than the expected witness.
4. The witness calls Blocky402 `/verify` then `/settle`. The facilitator adds its fee-payer signature
   and submits — it cannot alter the memo, which is inside the body the runner signed.
   `settle.transaction` is `pay_tx`; the witness returns it in `PAYMENT-RESPONSE`.
5. **Check 1**: the witness reads the settled transaction back from the mirror node
   (`GET /api/v1/transactions/<dashed id>`) and requires `result == SUCCESS`, `memo_base64` decoding
   to `h`, `transfers[]` crediting the witness by ≥ the price, the debit matching the project's
   registered pay account, and `consensus_timestamp` within 600 s. Mirror ingestion lags ~1–2 s, so
   this retries 3 × 400 ms.
6. Checks 2–9 (JWT, commitment cross-check, policy, workflow, generation, budget, revocation,
   replay). On success a `released` message carrying `pay_tx` is published to the project's HCS topic
   **before** share B is returned.

Budget: ~3 s settlement + ~3 s consensus + checks ≈ 7–10 s per release.

## Why the runner pays

Because it makes the commitment the runner's, not the witness's. A witness can omit a message it
authored; it cannot omit a Hedera transfer the runner signed. `klaxon-verify` reads every payment to
the witness account from the public mirror node and flags any without a matching `released`/`refused`
message as **`WITNESS WITHHELD`**. A worm that tries to pull a secret from the wrong job *pays to be
refused* — its own payment is the evidence, and the phone notification links to it on HashScan.

The property this buys is precise: **no first decryption without a runner-authored,
consensus-timestamped commitment.** It is about the first release of a given
`(project, secret, generation)`; share B is deterministic, so an attacker who captured it during an
earlier legitimate release needs no further payment. `docs/CLAIM.md` and `docs/THREAT-MODEL.md` state
that limit in full.

## Accounting

- **Who is bound to what.** The fee payer on-chain is Blocky402, so `payer_account_id` is the
  facilitator's account and proves nothing about who requested the release. Neither side binds on it.
  - The **witness** (check 1) binds on: `result == SUCCESS`, memo, the credit to its own account,
    freshness, and — when the project has a registered pay account — the **debit** in `transfers[]`
    being that account. That last binding is what makes "the runner itself paid" enforceable rather
    than merely conventional; without it, any funded stranger's memo'd transfer would satisfy the
    payment check.
  - **`klaxon-verify`**, which is a third-party reader with no witness involvement, binds on
    `result == SUCCESS`, a 64-hex memo, and a net credit to the witness account
    (`packages/verify/src/mirror/payments.ts`). It deliberately does not re-check the debit: the
    registered pay account is witness-held state, and a verifier that trusted it would be trusting
    the party it audits.
- **No separate signature check is needed for the debit, and none is performed.** Hedera requires the
  signature of every account whose balance decreases for a `CRYPTOTRANSFER` to reach consensus with
  `result == SUCCESS`. A settled debit therefore *is* an authorization by that account. The one
  caveat: an allowance-based transfer is signed by the spender rather than the owner and is marked
  `is_approval` in `transfers[]`. KLAXON's own client never builds one, and neither the witness nor
  `verify` currently inspects that flag.
- `KLAXON_PAY` is a dedicated account holding a few ℏ. At 0.001 ℏ per release, 5 ℏ is ~5,000
  releases. The runner needs no HBAR for network fees.
- Blocky402 is a prize-compliance choice: `x402.org/facilitator` also settles `hedera:testnet`. The
  requirement says Blocky402, so the facilitator URL is pinned to
  `https://api.testnet.blocky402.com` (mainnet: `https://api.blocky402.com`).

## Every payment is on HCS too

Each `released` and `refused` message carries its `pay_tx`, so the authorization trail and the payment
trail land in one consensus order. `verify` reconciles the two.
