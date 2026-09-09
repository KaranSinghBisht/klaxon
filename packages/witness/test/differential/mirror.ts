import type { RawTransaction } from "../../../verify/src/mirror/payments.js";
import type { RawTopicMessage } from "../../../verify/src/mirror/topic.js";
import { PAY_ACCOUNT as RUNNER_ACCOUNT } from "../helpers/fixtures.js";
import type { CapturedMessage, CapturedPayment } from "./capture.js";

/**
 * Render a witness run into the exact JSON the Hedera mirror node would serve for it, so `verify`
 * can be pointed at the witness's own output with nothing shared between the two but this file.
 *
 * The rules encoded here are the ones PROTOCOL fixes, and each is a place the two implementations
 * could silently disagree: base64 memos, the dashed transaction id with nanoseconds padded to
 * nine (§5), and a message over 1024 bytes split into chunks whose **last** consensus timestamp
 * is the message's (§7).
 */

/** `CHUNK_SIZE` in `@hiero-ledger/sdk`; a `released` carrying a GitHub OIDC token exceeds it. */
export const CHUNK_BYTES = 1024;

/** Blocky402's account: the fee payer on chain, deliberately not the runner (PROTOCOL §5). */
export const FEE_PAYER = "0.0.7162784";
/**
 * The account `FakePaymentPort` reports as the payer of the x402 debit. Same constant the harness
 * registers as the project's `pay_account`: `verify` pairs a payment to a commitment through this
 * account, so a fixture that renders a different one is not rendering the run it claims to.
 */
export { RUNNER_ACCOUNT };

const NODE_ACCOUNT = "0.0.802";
const CHARGED_FEE = 246_668;

const NANOS = 1_000_000_000n;

function toNanos(consensusTimestamp: string): bigint {
  const [head, frac = ""] = consensusTimestamp.split(".");
  return BigInt(head ?? "0") * NANOS + BigInt(frac.padEnd(9, "0"));
}

function fromNanos(total: bigint): string {
  const secs = total / NANOS;
  const rest = total % NANOS;
  return `${secs}.${rest.toString().padStart(9, "0")}`;
}

/** `t` minus `n` nanoseconds, borrowing across the second the way real timestamps do. */
export function minusNanos(consensusTimestamp: string, n: number): string {
  return fromNanos(toNanos(consensusTimestamp) - BigInt(n));
}

/**
 * `0.0.4821@1700000000.1` → `0.0.4821-1700000000-000000001`.
 *
 * The witness records whichever form x402 settlement handed it; the mirror node always answers
 * with the dashed form and nine-digit nanoseconds. `verify` has to reconcile the two, and this is
 * the only place in the test that knows they differ.
 */
export function mirrorTxId(sdkId: string): string {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(sdkId.trim());
  if (!m) return sdkId.trim();
  return `${m[1]}-${m[2]}-${(m[3] as string).padStart(9, "0")}`;
}

export interface TransactionOptions {
  witnessAccount: string;
  payerAccount?: string;
}

/** One settled `CRYPTOTRANSFER` per payment, with the memo the runner set and the transfer legs
 *  `verify` nets to decide the witness was actually credited. */
export function renderTransactions(
  payments: readonly CapturedPayment[],
  options: TransactionOptions,
): RawTransaction[] {
  const payer = options.payerAccount ?? RUNNER_ACCOUNT;
  return payments.map((p) => {
    const amount = Number(p.amountTinybar);
    return {
      charged_tx_fee: CHARGED_FEE,
      consensus_timestamp: p.consensusTimestamp,
      memo_base64: Buffer.from(p.h, "utf8").toString("base64"),
      name: "CRYPTOTRANSFER",
      result: "SUCCESS",
      transaction_id: mirrorTxId(p.payTx),
      payer_account_id: FEE_PAYER,
      transfers: [
        { account: NODE_ACCOUNT, amount: CHARGED_FEE, is_approval: false },
        { account: FEE_PAYER, amount: -CHARGED_FEE, is_approval: false },
        { account: payer, amount: -amount, is_approval: false },
        { account: options.witnessAccount, amount, is_approval: false },
      ],
    };
  });
}

export interface DroppedChunk {
  /** Index into the captured message list, in publish order. */
  messageIndex: number;
  /** 1-based chunk number the mirror node has not ingested. */
  number: number;
}

export interface TopicOptions {
  /** Simulates a mid-ingestion read: the chunk was submitted, the mirror has not served it yet. */
  dropChunk?: DroppedChunk;
  payerAccount?: string;
}

export function chunkCount(message: CapturedMessage): number {
  const bytes = Buffer.byteLength(JSON.stringify(message.message), "utf8");
  return Math.max(1, Math.ceil(bytes / CHUNK_BYTES));
}

/**
 * Split one published message into the rows the mirror node would return for it.
 *
 * The **last** chunk carries the consensus timestamp and sequence number the witness recorded for
 * the whole message, because that is what `getRecord()` on the final chunk reports and what
 * PROTOCOL §7 tells readers to use. Earlier chunks reach consensus a nanosecond apart before it.
 */
function renderChunks(
  message: CapturedMessage,
  sequenceOfLastChunk: number,
  payer: string,
): RawTopicMessage[] {
  const bytes = Buffer.from(JSON.stringify(message.message), "utf8");
  const total = chunkCount(message);
  const validStart = minusNanos(message.consensusTimestamp, Number(NANOS));
  const rows: RawTopicMessage[] = [];
  for (let number = 1; number <= total; number++) {
    const behind = total - number;
    rows.push({
      chunk_info:
        total === 1
          ? null
          : {
              initial_transaction_id: {
                account_id: payer,
                transaction_valid_start: validStart,
                nonce: 0,
                scheduled: false,
              },
              number,
              total,
            },
      consensus_timestamp: minusNanos(message.consensusTimestamp, behind),
      message: bytes.subarray((number - 1) * CHUNK_BYTES, number * CHUNK_BYTES).toString("base64"),
      sequence_number: sequenceOfLastChunk - behind,
      topic_id: message.topicId,
      payer_account_id: payer,
    });
  }
  return rows;
}

/**
 * Every published message as mirror-node rows, in consensus order.
 *
 * Sequence numbers are re-counted per chunk, which is what the chain does: a three-chunk message
 * consumes three of them. The fake HCS port counts one per `publish()`, so its numbers are the
 * un-chunked view and only the consensus timestamps are compared across the two sides.
 */
export function renderTopic(
  messages: readonly CapturedMessage[],
  options: TopicOptions = {},
): RawTopicMessage[] {
  const payer = options.payerAccount ?? FEE_PAYER;
  const rows: RawTopicMessage[] = [];
  let sequence = 0;
  messages.forEach((message, messageIndex) => {
    const total = chunkCount(message);
    sequence += total;
    for (const row of renderChunks(message, sequence, payer)) {
      const dropped =
        options.dropChunk?.messageIndex === messageIndex &&
        options.dropChunk.number === (row.chunk_info?.number ?? 1);
      if (!dropped) rows.push(row);
    }
  });
  return rows;
}
