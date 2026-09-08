import type { Harness } from "../helpers/harness.js";

/**
 * What the witness's own ports saw, before anything is rendered into mirror-node JSON.
 *
 * The capture is deliberately dumb: it copies what the fakes recorded and nothing else. Every
 * interpretation — dashed transaction ids, base64, chunking, the last-chunk timestamp rule —
 * belongs in `mirror.ts`, so a disagreement between the witness and `verify` shows up as a failing
 * assertion rather than as a helper quietly normalising one side into the other.
 */
export interface CapturedPayment {
  /** The commitment hash the runner put in the transaction memo (PROTOCOL §1). */
  h: string;
  /** SDK form, `0.0.X@seconds.nanos` — exactly what x402 settlement handed the witness. */
  payTx: string;
  consensusTimestamp: string;
  /** Tinybars credited to the witness account. */
  amountTinybar: string;
}

export interface CapturedMessage {
  topicId: string;
  message: Record<string, unknown>;
  sequenceNumber: string;
  consensusTimestamp: string;
}

export interface Capture {
  payments: CapturedPayment[];
  messages: CapturedMessage[];
}

function seconds(consensusTimestamp: string): bigint {
  const head = consensusTimestamp.split(".")[0];
  return BigInt(head ?? "0");
}

/**
 * Every x402 settlement the fake facilitator made, dated with the consensus timestamp check 1
 * read back off the (fake) mirror node. A settlement the witness never read back on chain is an
 * error rather than a guess: inventing a timestamp here would let the transform decide the
 * ordering that PROTOCOL §9 makes `verify` check.
 */
export function capturePayments(h: Harness): CapturedPayment[] {
  const payments: CapturedPayment[] = [];
  for (const [hash, settlement] of h.payment.settlements) {
    const consensusTimestamp = h.payment.onChain.get(settlement.payTx);
    if (consensusTimestamp === undefined) {
      throw new Error(`payment ${settlement.payTx} for ${hash} was never read back on chain`);
    }
    payments.push({
      h: settlement.memo,
      payTx: settlement.payTx,
      consensusTimestamp,
      amountTinybar: h.config.X402_PRICE_TINYBAR,
    });
  }
  payments.sort((a, b) => Number(seconds(a.consensusTimestamp) - seconds(b.consensusTimestamp)));
  return payments;
}

/** What the fake HCS port published, in publish order, with the coordinates it assigned. */
export function captureMessages(h: Harness): CapturedMessage[] {
  return h.hcs.messages.map((m) => ({
    topicId: m.topicId,
    message: m.message,
    sequenceNumber: m.sequenceNumber,
    consensusTimestamp: m.consensusTimestamp,
  }));
}

export function capture(h: Harness): Capture {
  return { payments: capturePayments(h), messages: captureMessages(h) };
}

/** The one message of `type` the topic carries, or a loud failure if that is not true. */
export function onlyMessageOfType(capture: Capture, type: string): CapturedMessage {
  const matches = capture.messages.filter((m) => m.message.type === type);
  const first = matches[0];
  if (matches.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one ${type} message, found ${matches.length}`);
  }
  return first;
}
