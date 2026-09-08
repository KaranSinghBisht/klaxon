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
 */
export function klaxonSigner(accountId: string, key: PrivateKey): ClientHederaSigner {
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
