import { describe, expect, it } from "vitest";
import { DEFAULT_MIRROR_URL, MirrorClient } from "../src/mirror/client.js";
import { type RawTopicMessage, reassemble, topicMessagesPath } from "../src/mirror/topic.js";

/**
 * The one test that leaves the machine. Opt in with `KLAXON_LIVE=1`; everything else in this
 * package runs against recorded fixtures so a green suite never depends on Hedera being up.
 *
 * `0.0.1926` is a long-lived public testnet topic carrying plain-text messages, not KLAXON
 * envelopes — which makes it a good live check of exactly two things: that `links.next`
 * pagination works against the real mirror node, and that content we cannot parse is reported
 * rather than silently dropped.
 */
const live = process.env.KLAXON_LIVE === "1" ? describe : describe.skip;

live("public Hedera testnet mirror node", () => {
  it("paginates a long topic through links.next", async () => {
    const requested: string[] = [];
    const client = new MirrorClient({
      baseUrl: DEFAULT_MIRROR_URL,
      maxPages: 3,
      fetch: async (input, init) => {
        requested.push(input);
        return globalThis.fetch(input, init);
      },
    });

    const raw = await client.collect<
      { messages?: RawTopicMessage[]; links?: { next?: string | null } },
      RawTopicMessage
    >(topicMessagesPath("0.0.1926"), (page) => page.messages);

    expect(requested.length).toBeGreaterThan(1);
    expect(requested[0]).toBe(
      `${DEFAULT_MIRROR_URL}/api/v1/topics/0.0.1926/messages?limit=100&order=asc`,
    );
    // Page two onwards arrives as a path in `links.next`, which the client resolves to the origin.
    expect(requested[1]).toMatch(
      /^https:\/\/testnet\.mirrornode\.hedera\.com\/api\/v1\/topics\/0\.0\.1926\/messages\?/,
    );
    expect(requested[1]).toContain("timestamp=gt:");
    expect(raw.length).toBeGreaterThanOrEqual(200);

    for (const message of raw) {
      expect(message.consensus_timestamp).toMatch(/^\d+\.\d{9}$/);
    }

    // Every group is accounted for: parsed, incomplete, or malformed — none vanish.
    const read = reassemble(raw);
    expect(read.messages.length + read.incomplete.length + read.malformed.length).toBe(raw.length);
    expect(read.malformed.length).toBeGreaterThan(0);
  }, 60_000);
});
