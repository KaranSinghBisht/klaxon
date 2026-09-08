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
 *
 * `executeAll()`, not `execute()`: the SDK's `execute()` submits every chunk but returns only the
 * **first** one's response, so a chunked envelope would be reported at the first chunk's
 * consensus timestamp and sequence number. PROTOCOL §7 fixes the reader's rule as the **last**
 * chunk's, and `verify` follows it, so reporting the first would put the witness's own answer at
 * odds with every auditor for any message over 1024 bytes — which a `released` carrying a JWT is.
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
    const responses = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(JSON.stringify(message))
      .setMaxChunks(20)
      .executeAll(this.client);
    const last = responses[responses.length - 1];
    if (last === undefined) {
      throw new Error("topic submit returned no transaction response");
    }
    const record = await last.getRecord(this.client);
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
