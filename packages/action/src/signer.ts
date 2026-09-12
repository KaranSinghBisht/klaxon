import type { PaymentRequirements } from "@x402/core/types";
// SDK primitives come from `@x402/hedera`'s re-exports and never from `@hiero-ledger/sdk` or
// `@hashgraph/sdk` directly (D33): two on-disk SDK copies break `instanceof` and crash the
// facilitator handshake with `t.startsWith is not a function`.
import {
  AccountId,
  Client,
  type ClientHederaSigner,
  Hbar,
  type PrivateKey,
  TransactionId,
  TransferTransaction,
} from "@x402/hedera";

/**
 * The whole reason KLAXON needs a custom signer: `@x402/*` has no memo concept, so the transaction
 * memo — which is the release commitment hash `h` — can only be stamped here, by the party with the
 * security interest. The witness re-reads it from the mirror node after settlement and `verify`
 * re-reads it from public data (PROTOCOL §5, B §2.3).
 *
 * Refusing when `extra.memo` is absent is load-bearing: an unmemoed payment would settle, cost real
 * HBAR, and then be refused by witness check 1 with no way to pair it to this run.
 *
 * And the memo is checked against the commitment THIS runner computed, not merely accepted. The
 * whole claim is that the runner authored the record, so taking the server's word for what it is
 * about would hand the witness the pen: a 402 quoting someone else's `h` would have the runner pay,
 * in its own name, for a commitment it never made. `expected` is threaded from the transport, which
 * knows `h` because it is the URL it is about to POST to.
 */
export interface ExpectedCommitment {
  /** The `h` this runner computed. `null` disables the check, for harnesses that own both sides. */
  h: string | null;
}

export function klaxonSigner(
  accountId: string,
  key: PrivateKey,
  expected: ExpectedCommitment = { h: null },
): ClientHederaSigner {
  const me = AccountId.fromString(accountId);
  return {
    accountId: me.toString(),
    async createPartiallySignedTransferTransaction(req: PaymentRequirements): Promise<string> {
      const extra: Record<string, unknown> = req.extra ?? {};
      const feePayer = extra.feePayer;
      const memo = extra.memo;
      if (typeof feePayer !== "string" || feePayer.length === 0) {
        throw new Error("KLAXON: 402 did not carry extra.feePayer — refusing to pay");
      }
      if (typeof memo !== "string" || memo.length === 0) {
        throw new Error("KLAXON: 402 did not carry extra.memo — refusing to pay");
      }
      if (expected.h !== null && memo !== expected.h) {
        throw new Error(
          `KLAXON: the 402 asked us to stamp a commitment we did not make (got ${memo.slice(0, 16)}…, expected ${expected.h.slice(0, 16)}…) — refusing to pay`,
        );
      }
      const amount = BigInt(req.amount);
      const tx = new TransferTransaction()
        .addHbarTransfer(me, Hbar.fromTinybars((-amount).toString()))
        .addHbarTransfer(AccountId.fromString(req.payTo), Hbar.fromTinybars(amount.toString()))
        .setTransactionMemo(memo)
        // The facilitator is the fee payer on chain; the runner is only the debit in `transfers[]`.
        .setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));

      // `forTestnet()` builds a static node map and `freezeWith` does no I/O, so this path is
      // fully offline — which is what lets the memo proof run as a unit test.
      const client = Client.forTestnet();
      try {
        tx.freezeWith(client);
        const signed = await tx.sign(key);
        return Buffer.from(signed.toBytes()).toString("base64");
      } finally {
        client.close();
      }
    },
  };
}
