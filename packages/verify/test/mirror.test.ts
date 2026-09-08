import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MirrorClient } from "../src/mirror/client.js";
import {
  paymentsPath,
  readPayments,
  selectPayments,
  toDashedTxId,
  txIdKey,
} from "../src/mirror/payments.js";
import { type RawTopicMessage, readTopic, reassemble } from "../src/mirror/topic.js";

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"),
  ) as T;
}

const chunks = fixture<{
  messages: RawTopicMessage[];
  expected: { A: string; B: string; D: string };
}>("topic-chunks.json");

describe("chunk reassembly", () => {
  const read = reassemble(chunks.messages);

  it("reassembles out-of-order chunks by concatenating bytes, not strings", () => {
    const a = read.messages.find(
      (m) => m.chunks === 2 && (m.json as { type: string }).type === "rotate",
    );
    expect(a).toBeDefined();
    // The multibyte character straddling the chunk boundary survives only if bytes were joined.
    expect(JSON.stringify(a?.json)).toBe(chunks.expected.A);
    const note = (a as { json: { note: string } }).json.note;
    expect(note).toContain("généré — ünïcodé ✅");
  });

  it("keeps two interleaved messages apart by initial_transaction_id", () => {
    const d = read.messages.find(
      (m) => (m.json as { reason?: string }).reason === "interleaved with A",
    );
    expect(JSON.stringify(d?.json)).toBe(chunks.expected.D);
    expect(read.messages).toHaveLength(3);
  });

  it("treats a message with no chunk_info as a single chunk", () => {
    const b = read.messages.find((m) => (m.json as { type: string }).type === "jwks");
    expect(b?.chunks).toBe(1);
    expect(JSON.stringify(b?.json)).toBe(chunks.expected.B);
  });

  it("uses the LAST chunk's consensus timestamp as the message timestamp", () => {
    const a = read.messages.find((m) => (m.json as { type: string }).type === "rotate");
    expect(a?.consensusTimestamp).toBe("1000.200000000");
  });

  it("reports an incomplete group instead of dropping it", () => {
    expect(read.incomplete).toHaveLength(1);
    expect(read.incomplete[0]).toMatchObject({ have: 2, total: 3 });
    expect(read.incomplete[0]?.key).toBe("0.0.100@1002.000000002");
    expect(
      read.messages.some((m) => (m.json as { reason?: string }).reason === "never fully ingested"),
    ).toBe(false);
  });

  it("orders messages by consensus timestamp", () => {
    const stamps = read.messages.map((m) => m.consensusTimestamp);
    expect(stamps).toEqual([...stamps].sort());
  });

  it("reports a chunk group that reassembles into non-JSON", () => {
    const bad = reassemble([
      {
        chunk_info: null,
        consensus_timestamp: "1.000000000",
        message: Buffer.from("not json", "utf8").toString("base64"),
        sequence_number: 1,
      },
    ]);
    expect(bad.messages).toHaveLength(0);
    expect(bad.malformed).toHaveLength(1);
  });
});

describe("mirror pagination", () => {
  it("follows links.next, which is a path and not an absolute URL", async () => {
    const page1 = fixture<unknown>("topic-page1.json");
    const page2 = fixture<unknown>("topic-page2.json");
    const seen: string[] = [];
    const client = new MirrorClient({
      baseUrl: "https://testnet.mirrornode.hedera.com/api/v1",
      fetch: async (input) => {
        seen.push(input);
        const body = seen.length === 1 ? page1 : page2;
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    const read = await readTopic(client, "0.0.4321");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.4321/messages?limit=100&order=asc",
    );
    expect(seen[1]).toContain("timestamp=gt:1000.300000000");
    expect(read.messages).toHaveLength(3);
    expect(read.incomplete).toHaveLength(1);
  });

  it("retries 429 and 5xx with backoff, then gives up loudly", async () => {
    let attempts = 0;
    const client = new MirrorClient({
      baseUrl: "https://mirror.example",
      maxRetries: 3,
      sleep: async () => undefined,
      fetch: async () => {
        attempts += 1;
        return attempts < 3
          ? new Response("slow down", { status: 429 })
          : new Response(JSON.stringify({ messages: [], links: { next: null } }), { status: 200 });
      },
    });
    await expect(client.getJson("/api/v1/topics/0.0.1/messages")).resolves.toEqual({
      messages: [],
      links: { next: null },
    });
    expect(attempts).toBe(3);

    const dead = new MirrorClient({
      baseUrl: "https://mirror.example",
      maxRetries: 1,
      sleep: async () => undefined,
      fetch: async () => new Response("boom", { status: 503 }),
    });
    await expect(dead.getJson("/api/v1/x")).rejects.toThrow(/unreachable after 2 attempts/);
  });

  it("does not retry a 404", async () => {
    let attempts = 0;
    const client = new MirrorClient({
      baseUrl: "https://mirror.example",
      sleep: async () => undefined,
      fetch: async () => {
        attempts += 1;
        return new Response("nope", { status: 404 });
      },
    });
    await expect(client.getJson("/api/v1/x")).rejects.toThrow(/404/);
    expect(attempts).toBe(1);
  });
});

describe("payments", () => {
  const raw = fixture<{ transactions: Parameters<typeof selectPayments>[0] }>("payments.json");

  it("converts the SDK's @ form to the mirror node's dashed form", () => {
    expect(toDashedTxId("0.0.7162784@1788848300.493972399")).toBe(
      "0.0.7162784-1788848300-493972399",
    );
    expect(toDashedTxId("0.0.7162784-1788848300-493972399")).toBe(
      "0.0.7162784-1788848300-493972399",
    );
    expect(toDashedTxId("0.0.5@1788848300")).toBe("0.0.5-1788848300");
    expect(txIdKey("0.0.5@1.1")).toBe("0.0.5-1-000000001");
    expect(txIdKey("0.0.5-1-000000001")).toBe("0.0.5-1-000000001");
  });

  it("keeps only settled transfers that credit the witness and carry a commitment memo", () => {
    const payments = selectPayments(raw.transactions, "0.0.4820");
    expect(payments.map((p) => p.memo)).toEqual(["1".repeat(64), "2".repeat(64)]);
    expect(payments[0]?.amount).toBe(100000n);
    expect(payments[0]?.transactionId).toBe("0.0.7162784-1788848300-493972399");
    // The `@`-form id from the mirror is normalised on the way in.
    expect(payments[1]?.transactionId).toBe("0.0.7162784-1788848304-000000004");
  });

  it("builds the documented query", () => {
    expect(paymentsPath("0.0.4820", "1788848300.0")).toBe(
      "/api/v1/transactions?account.id=0.0.4820&transactiontype=CRYPTOTRANSFER&order=asc&limit=100&timestamp=gte%3A1788848300.0",
    );
  });

  it("reads payments through the client", async () => {
    const client = new MirrorClient({
      baseUrl: "https://mirror.example",
      fetch: async () => new Response(JSON.stringify(raw), { status: 200 }),
    });
    const payments = await readPayments(client, "0.0.4820");
    expect(payments).toHaveLength(2);
  });
});
