import {
  AccountId,
  Client,
  PrivateKey,
  TopicId,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import type { WitnessConfig } from "../env.js";
import type { HcsPort, HcsPublished } from "../ports/index.js";

/**
 * HCS submits (B §3.3). **`@hiero-ledger/sdk` only** (D33): `@x402/hedera` already pulls it into
 * this package, and two Hedera SDK copies in one process crash at runtime
 * (`t.startsWith is not a function`). Never import `@hashgraph/sdk` here.
 *
 * `getRecord()`, not `getReceipt()`: a receipt carries the sequence number but no consensus
 * timestamp (D12), and the consensus timestamp is the thing the whole claim rests on.
 * Chunking is automatic inside `freezeWith()`; a 2 KB envelope is 2–3 chunks.
 */
export class HederaHcsAdapter implements HcsPort {
  readonly submitKeyDer: string;
  private readonly client: Client;

  constructor(config: WitnessConfig) {
    const key = parseOperatorKey(config.HEDERA_OPERATOR_KEY, config.HEDERA_KEY_TYPE);
    this.submitKeyDer = key.publicKey.toStringDer();
    this.client = Client.forName(config.HEDERA_NETWORK).setOperator(
      AccountId.fromString(config.HEDERA_OPERATOR_ID),
      key,
    );
  }

  async publish(topicId: string, message: unknown): Promise<HcsPublished> {
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(JSON.stringify(message))
      .setMaxChunks(20)
      .execute(this.client);
    const record = await response.getRecord(this.client);
    const seq = record.receipt.topicSequenceNumber;
    if (seq === null) {
      throw new Error("topic submit returned no sequence number");
    }
    return {
      sequenceNumber: seq.toString(),
      consensusTimestamp: timestampToString(record.consensusTimestamp),
    };
  }

  close(): void {
    this.client.close();
  }
}

export function parseOperatorKey(
  raw: string,
  kind: "ecdsa" | "ed25519" | "der",
): ReturnType<typeof PrivateKey.fromStringECDSA> {
  if (kind === "ecdsa") return PrivateKey.fromStringECDSA(raw);
  if (kind === "ed25519") return PrivateKey.fromStringED25519(raw);
  return PrivateKey.fromStringDer(raw);
}

/** `seconds.nanos`, nanos zero-padded to 9 — the exact form the mirror node returns. */
export function timestampToString(ts: {
  seconds: { toString(): string };
  nanos: { toString(): string };
}): string {
  return `${ts.seconds.toString()}.${ts.nanos.toString().padStart(9, "0")}`;
}
