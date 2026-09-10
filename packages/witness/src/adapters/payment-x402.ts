import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import type { WitnessConfig } from "../env.js";
import type { Logger } from "../log.js";
import type {
  OnChainExpectation,
  OnChainOutcome,
  PaymentPort,
  PaymentRequiredAnswer,
  SettleOutcome,
} from "../ports/index.js";
import { OUTBOUND_TIMEOUT_MS, timeoutSignal } from "./http.js";
import { creditedTo, decodeMemo, MirrorNodeClient } from "./mirror-node.js";

/**
 * x402 on Hedera via Blocky402 (B §2.2, D11).
 *
 * `x402ResourceServer` is driven directly rather than through `x402HTTPResourceServer`'s static
 * route map, because KLAXON's requirements are per-request: `extra.memo` is the commitment hash
 * from the path. Price is an `AssetAmount` — a money string throws for HBAR (D11/C4).
 *
 * The memo is not enforced by the facilitator (`@x402/*` has no memo concept). The chain of
 * custody is: witness advertises `extra.memo = h` → the runner's custom signer stamps it with
 * `setTransactionMemo` → the facilitator submits without touching it → the witness reads the
 * settled transaction back from the mirror node and asserts the memo itself (B §2.3).
 */

/**
 * `/health` is polled by Fly on a short interval and the answer barely changes between polls, so
 * the facilitator probe is cached this long. Short enough that a dead Blocky402 is red within
 * seconds, long enough that a health check never becomes a load generator.
 */
const FACILITATOR_PROBE_TTL_MS = 5_000;

export interface X402AdapterOptions {
  /** Deadline for the facilitator probe and, via the client, for `verify` and `settle`. */
  timeoutMs?: number;
  probeTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class X402PaymentAdapter implements PaymentPort {
  private readonly rs: x402ResourceServer;
  private readonly mirror: MirrorNodeClient;
  private readonly timeoutMs: number;
  private readonly probeTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private probe: { at: number; ok: boolean } | null = null;

  constructor(
    private readonly config: WitnessConfig,
    private readonly log: Logger,
    mirror?: MirrorNodeClient,
    opts: X402AdapterOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? OUTBOUND_TIMEOUT_MS;
    this.probeTtlMs = opts.probeTtlMs ?? FACILITATOR_PROBE_TTL_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.rs = new x402ResourceServer(
      // The client's own default is 30 s per call, which is longer than a runner will wait.
      new HTTPFacilitatorClient({ url: config.X402_FACILITATOR, timeoutMs: this.timeoutMs }),
    ).register(hederaNetworkGlob(config.X402_NETWORK), new ExactHederaScheme());
    this.mirror =
      mirror ?? new MirrorNodeClient({ baseUrl: config.MIRROR_NODE, timeoutMs: this.timeoutMs });
  }

  /**
   * Fetches `/supported` and injects `extra.feePayer`. B §2.6: if this fails at boot the witness
   * must refuse to start — never serve a 402 you cannot settle. `main.ts` awaits this before it
   * listens and exits on a throw, so there is no "booted but unusable" state for `health()` to
   * report; what `health()` has to catch is the facilitator dying *afterwards*.
   */
  async initialize(): Promise<void> {
    await this.rs.initialize();
  }

  price(): { amount: string; asset: string; network: string } {
    return {
      amount: this.config.X402_PRICE_TINYBAR,
      asset: this.config.X402_ASSET,
      network: this.config.X402_NETWORK,
    };
  }

  private async requirementsFor(h: string): Promise<PaymentRequirements[]> {
    return this.rs.buildPaymentRequirements({
      scheme: "exact",
      network: this.config.X402_NETWORK as Network,
      payTo: this.config.witnessAccount,
      price: { amount: this.config.X402_PRICE_TINYBAR, asset: this.config.X402_ASSET },
      maxTimeoutSeconds: this.config.X402_MAX_TIMEOUT_S,
      extra: { memo: h },
    });
  }

  async buildRequirements(h: string): Promise<PaymentRequiredAnswer> {
    const requirements = await this.requirementsFor(h);
    const body = await this.rs.createPaymentRequiredResponse(
      requirements,
      {
        url: `${this.config.KLAXON_PUBLIC_URL}/release/${h}`,
        description: "KLAXON share B release",
        mimeType: "application/json",
        serviceName: "klaxon-witness",
      },
      "KLAXON release requires payment; transaction memo MUST equal the commitment hash",
    );
    return { body, header: encodePaymentRequiredHeader(body), requirements };
  }

  async verifyAndSettle(h: string, paymentSignatureHeader: string): Promise<SettleOutcome> {
    let payload: ReturnType<typeof decodePaymentSignatureHeader>;
    try {
      payload = decodePaymentSignatureHeader(paymentSignatureHeader);
    } catch {
      return { ok: false, infra: false, reason: "PAYMENT-SIGNATURE header is not decodable" };
    }

    let requirements: PaymentRequirements[];
    try {
      requirements = await this.requirementsFor(h);
    } catch (err) {
      this.log.error({ h, err }, "could not build payment requirements");
      return { ok: false, infra: true, reason: "facilitator unavailable" };
    }

    const chosen = this.rs.findMatchingRequirements(requirements, payload);
    if (!chosen) {
      return { ok: false, infra: false, reason: "payment does not match the advertised terms" };
    }

    try {
      const verified = await this.rs.verifyPayment(payload, chosen);
      if (!verified.isValid) {
        return { ok: false, infra: false, reason: verified.invalidReason ?? "payment is invalid" };
      }
    } catch (err) {
      this.log.error({ h, err }, "facilitator verify failed");
      return { ok: false, infra: true, reason: "facilitator verify failed" };
    }

    try {
      const settle = await this.rs.settlePayment(payload, chosen);
      if (!settle.success) {
        // Settlement trouble is Hedera's or the facilitator's, not the runner's (B §2.6).
        return {
          ok: false,
          infra: true,
          reason: settle.errorReason ?? "settlement did not complete",
        };
      }
      return {
        ok: true,
        payTx: settle.transaction,
        payer: settle.payer,
        responseHeader: encodePaymentResponseHeader(settle),
        settle,
      };
    } catch (err) {
      this.log.error({ h, err }, "facilitator settle failed");
      return { ok: false, infra: true, reason: "facilitator settle failed" };
    }
  }

  /** Check 1's evidence: the settled transaction, read back from public data. */
  async verifySettledOnChain(payTx: string, expect: OnChainExpectation): Promise<OnChainOutcome> {
    let transactions: Awaited<ReturnType<MirrorNodeClient["getTransaction"]>>;
    try {
      transactions = await this.mirror.getTransaction(payTx);
    } catch (err) {
      this.log.warn({ pay_tx: payTx, err }, "mirror node unreachable");
      return { ok: false, infra: true, reason: "mirror node unreachable" };
    }
    if (transactions === null) {
      return { ok: false, infra: true, reason: "payment is not visible on the mirror node yet" };
    }

    const transfer = transactions.find((t) => t.name === "CRYPTOTRANSFER") ?? transactions[0];
    if (!transfer) {
      return { ok: false, infra: true, reason: "mirror node returned no transaction" };
    }
    if (transfer.result !== "SUCCESS") {
      return { ok: false, infra: false, reason: `payment did not succeed (${transfer.result})` };
    }
    if (decodeMemo(transfer.memo_base64) !== expect.memo) {
      return {
        ok: false,
        infra: false,
        reason: "payment memo does not equal the commitment hash",
      };
    }
    const credited = creditedTo(transfer, expect.toAccount);
    if (credited < BigInt(expect.minAmount)) {
      return { ok: false, infra: false, reason: "payment did not credit the witness in full" };
    }
    return {
      ok: true,
      consensusTimestamp: transfer.consensus_timestamp,
      payerAccount: payerOf(transfer, expect.toAccount, credited),
      amount: credited.toString(),
    };
  }

  async health(): Promise<{ facilitator: boolean; mirror: boolean }> {
    const [facilitator, mirror] = await Promise.all([
      this.facilitatorHealth(),
      this.mirror.health(),
    ]);
    return { facilitator, mirror };
  }

  /**
   * A live read of `/supported` — the same document `initialize()` consumes — not a flag set once
   * at boot. A boot flag keeps answering `true` with Blocky402 dead underneath, which is precisely
   * the failure `/health` exists to catch: Fly would keep routing releases to a machine that can
   * advertise a 402 it cannot settle. `PROTOCOL §2` fails closed on a red answer, so an
   * unreachable facilitator is `false`, never "assume fine".
   */
  private async facilitatorHealth(): Promise<boolean> {
    const now = this.now();
    if (this.probe && now - this.probe.at < this.probeTtlMs) return this.probe.ok;
    let ok = false;
    try {
      const res = await this.fetchImpl(
        `${this.config.X402_FACILITATOR.replace(/\/+$/, "")}/supported`,
        {
          headers: { accept: "application/json" },
          signal: timeoutSignal(this.timeoutMs),
        },
      );
      ok = res.ok;
    } catch (err) {
      this.log.warn({ err }, "facilitator probe failed");
    }
    this.probe = { at: now, ok };
    return ok;
  }
}

/**
 * The debit side of the transfer list is the runner. The fee payer on chain is Blocky402's
 * account, so `payer_account_id` is never the right answer (PROTOCOL §5).
 */
function payerOf(
  tx: { transfers: { account: string; amount: number }[] },
  witnessAccount: string,
  credited: bigint,
): string {
  // The payer funded the value: their debit equals what the witness was credited. The facilitator's
  // debit is the (larger, unrelated) network fee, so match the amount — never "most negative",
  // which picks the fee payer. Gate B surfaced exactly that: Blocky402's -262247 fee debit
  // out-sorted the runner's -100000 value debit.
  const match = (tx.transfers ?? []).find(
    (t) => t.account !== witnessAccount && t.amount < 0 && BigInt(-t.amount) === credited,
  );
  return match?.account ?? "";
}

/** `hedera:testnet` registers under `hedera:*` so the scheme covers every Hedera network id. */
function hederaNetworkGlob(network: string): Network {
  const [namespace] = network.split(":");
  return `${namespace ?? "hedera"}:*` as Network;
}
