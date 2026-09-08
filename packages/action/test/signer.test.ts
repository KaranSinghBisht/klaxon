import type { PaymentRequirements } from "@x402/core/types";
import { PrivateKey, Transaction, type TransferTransaction } from "@x402/hedera";
import { describe, expect, it } from "vitest";
import { klaxonSigner } from "../src/signer.js";

/** A 64-hex commitment hash, exactly what `extra.memo` carries on a real 402. */
const MEMO = `8f2e${"a3".repeat(30)}`;
const FEE_PAYER = "0.0.7162784"; // Blocky402's testnet fee payer
const RUNNER = "0.0.9876543";
const WITNESS = "0.0.1234567";
const AMOUNT = "100000"; // 0.001 HBAR in tinybars

function requirements(extra: Record<string, unknown>): PaymentRequirements {
  return {
    scheme: "exact",
    network: "hedera:testnet",
    asset: "0.0.0",
    amount: AMOUNT,
    payTo: WITNESS,
    maxTimeoutSeconds: 120,
    extra,
  };
}

describe("klaxonSigner", () => {
  // The memo proof. `freezeWith(Client.forTestnet())` uses a static node map and performs no I/O,
  // so this runs fully offline — if it ever needs a network, the memo leg is not what it claims.
  it("stamps extra.memo onto the frozen transfer and debits the runner", async () => {
    const key = PrivateKey.generateECDSA();
    const signer = klaxonSigner(RUNNER, key);

    const b64 = await signer.createPartiallySignedTransferTransaction(
      requirements({ feePayer: FEE_PAYER, memo: MEMO }),
    );
    const tx = Transaction.fromBytes(Buffer.from(b64, "base64")) as TransferTransaction;

    expect(tx.transactionMemo).toBe(MEMO);
    expect(tx.hbarTransfers.get(RUNNER)?.toTinybars().toString()).toBe(`-${AMOUNT}`);
    expect(tx.hbarTransfers.get(WITNESS)?.toTinybars().toString()).toBe(AMOUNT);
    // The facilitator pays the fee, so the transaction id belongs to its account, not the runner's.
    expect(tx.transactionId?.accountId?.toString()).toBe(FEE_PAYER);
    expect(signer.accountId).toBe(RUNNER);
  });

  it("refuses to pay a 402 that carries no memo", async () => {
    const signer = klaxonSigner(RUNNER, PrivateKey.generateECDSA());
    await expect(
      signer.createPartiallySignedTransferTransaction(requirements({ feePayer: FEE_PAYER })),
    ).rejects.toThrow(/extra\.memo/);
  });

  it("refuses to pay a 402 that carries no feePayer", async () => {
    const signer = klaxonSigner(RUNNER, PrivateKey.generateECDSA());
    await expect(
      signer.createPartiallySignedTransferTransaction(requirements({ memo: MEMO })),
    ).rejects.toThrow(/extra\.feePayer/);
  });
});
