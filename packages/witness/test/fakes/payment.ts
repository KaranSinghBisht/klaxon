import type {
  OnChainExpectation,
  OnChainOutcome,
  PaymentPort,
  PaymentRequiredAnswer,
  SettleOutcome,
} from "../../src/ports/index.js";

/**
 * A payment port that settles in memory. It keeps the memo binding honest — `verifySettledOnChain`
 * really does compare the memo recorded at settle time against what check 1 expects — so the
 * chain-of-custody logic is exercised without touching Hedera.
 */
export type MirrorMode = "ok" | "infra" | "wrong-memo" | "failed" | "underpaid";

export class FakePaymentPort implements PaymentPort {
  mirrorMode: MirrorMode = "ok";
  /** Seconds subtracted from `now` when reporting the settlement's consensus timestamp. */
  settlementAgeS = 1;
  readonly settlements = new Map<string, { memo: string; payTx: string }>();
  private counter = 0;

  constructor(
    private readonly clock: () => Date,
    private readonly priceTinybars = "100000",
  ) {}

  price(): { amount: string; asset: string; network: string } {
    return { amount: this.priceTinybars, asset: "0.0.0", network: "hedera:testnet" };
  }

  async buildRequirements(h: string): Promise<PaymentRequiredAnswer> {
    const requirement = {
      scheme: "exact",
      network: "hedera:testnet" as const,
      asset: "0.0.0",
      amount: this.priceTinybars,
      payTo: "0.0.4820",
      maxTimeoutSeconds: 120,
      extra: { memo: h, feePayer: "0.0.7162784" },
    };
    const body = { x402Version: 2, accepts: [requirement], resource: { url: `/release/${h}` } };
    return {
      body,
      header: Buffer.from(JSON.stringify(body)).toString("base64"),
      requirements: [requirement],
    };
  }

  async verifyAndSettle(h: string, header: string): Promise<SettleOutcome> {
    if (header === "invalid") {
      return { ok: false, infra: false, reason: "payment is invalid" };
    }
    if (header === "facilitator-down") {
      return { ok: false, infra: true, reason: "facilitator settle failed" };
    }
    const existing = this.settlements.get(h);
    this.counter += 1;
    const payTx = existing?.payTx ?? `0.0.4821@1700000000.${this.counter}`;
    this.settlements.set(h, { memo: h, payTx });
    return {
      ok: true,
      payTx,
      payer: "0.0.10405046",
      responseHeader: Buffer.from(JSON.stringify({ transaction: payTx })).toString("base64"),
      settle: {
        success: true,
        transaction: payTx,
        network: "hedera:testnet",
        payer: "0.0.10405046",
      },
    };
  }

  /** Force the next settlement for `h` to reuse a `pay_tx` already spent elsewhere. */
  reuse(h: string, payTx: string): void {
    this.settlements.set(h, { memo: h, payTx });
  }

  /** Drop the remembered settlement so the next POST for `h` arrives with a *new* payment. */
  forget(h: string): void {
    this.settlements.delete(h);
  }

  async verifySettledOnChain(payTx: string, expect: OnChainExpectation): Promise<OnChainOutcome> {
    if (this.mirrorMode === "infra") {
      return { ok: false, infra: true, reason: "mirror node unreachable" };
    }
    if (this.mirrorMode === "failed") {
      return { ok: false, infra: false, reason: "payment did not succeed (INSUFFICIENT_TX_FEE)" };
    }
    if (this.mirrorMode === "underpaid") {
      return { ok: false, infra: false, reason: "payment did not credit the witness in full" };
    }
    const record = [...this.settlements.values()].find((s) => s.payTx === payTx);
    if (!record) return { ok: false, infra: true, reason: "not visible on the mirror node yet" };
    const memo = this.mirrorMode === "wrong-memo" ? "0".repeat(64) : record.memo;
    if (memo !== expect.memo) {
      return { ok: false, infra: false, reason: "payment memo does not equal the commitment hash" };
    }
    const seconds = Math.floor(this.clock().getTime() / 1000) - this.settlementAgeS;
    return {
      ok: true,
      consensusTimestamp: `${seconds}.000000000`,
      payerAccount: "0.0.10405046",
      amount: this.priceTinybars,
    };
  }

  async health(): Promise<{ facilitator: boolean; mirror: boolean }> {
    return { facilitator: true, mirror: this.mirrorMode !== "infra" };
  }
}
