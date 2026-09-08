import type { HcsPort, HcsPublished } from "../../src/ports/index.js";

export interface RecordedMessage {
  topicId: string;
  message: Record<string, unknown>;
  sequenceNumber: string;
  consensusTimestamp: string;
}

/** Nanosecond spacing between messages, leaving room below each for a chunked submit's earlier
 *  chunks when a test renders these into mirror-node rows. */
const NANOS_PER_MESSAGE = 1_000;

/**
 * An in-memory consensus log with monotonic sequence numbers. Every release test asserts on
 * `messages.length`, because "exactly one `released` per payment" is the property `verify` checks
 * from the other side.
 *
 * Consensus timestamps come from the harness clock — the same clock the payment port dates its
 * settlements from. A fixed epoch here would date every message years before the payment that
 * caused it, and any reader that compares the two orderings (PROTOCOL §9 `ORDERING`) would see an
 * honest witness answering before it was paid.
 */
export class FakeHcsPort implements HcsPort {
  readonly submitKeyDer = `302a300506032b6570032100${"11".repeat(32)}`;
  readonly messages: RecordedMessage[] = [];
  /** Set to make the next publish throw, exercising the outbox retry path. */
  failNext = false;
  private seq = 0;

  constructor(private readonly clock: () => Date) {}

  async publish(topicId: string, message: unknown): Promise<HcsPublished> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated HCS outage");
    }
    this.seq += 1;
    const seconds = Math.floor(this.clock().getTime() / 1000);
    const published = {
      sequenceNumber: String(this.seq),
      // Distinct nanos per message: the mirror node never returns two messages at the same
      // consensus timestamp, and `verify` groups unchunked messages by exactly that value.
      consensusTimestamp: `${seconds}.${String(this.seq * NANOS_PER_MESSAGE).padStart(9, "0")}`,
    };
    this.messages.push({
      topicId,
      message: message as Record<string, unknown>,
      ...published,
    });
    return published;
  }

  ofType(type: string): RecordedMessage[] {
    return this.messages.filter((m) => m.message.type === type);
  }
}
