import type { HcsPort, HcsPublished } from "../../src/ports/index.js";

export interface RecordedMessage {
  topicId: string;
  message: Record<string, unknown>;
  sequenceNumber: string;
  consensusTimestamp: string;
}

/**
 * An in-memory consensus log with monotonic sequence numbers. Every release test asserts on
 * `messages.length`, because "exactly one `released` per payment" is the property `verify` checks
 * from the other side.
 */
export class FakeHcsPort implements HcsPort {
  readonly submitKeyDer = `302a300506032b6570032100${"11".repeat(32)}`;
  readonly messages: RecordedMessage[] = [];
  /** Set to make the next publish throw, exercising the outbox retry path. */
  failNext = false;
  private seq = 0;

  async publish(topicId: string, message: unknown): Promise<HcsPublished> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated HCS outage");
    }
    this.seq += 1;
    const published = {
      sequenceNumber: String(this.seq),
      consensusTimestamp: `${1_700_000_000 + this.seq}.000000000`,
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
