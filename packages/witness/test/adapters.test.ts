import { describe, expect, it } from "vitest";
import { NtfyAlarmAdapter } from "../src/adapters/alarm-ntfy.js";
import { timestampToString } from "../src/adapters/hcs-hedera.js";
import {
  creditedTo,
  decodeMemo,
  MirrorNodeClient,
  type MirrorTransaction,
  toDashedTransactionId,
} from "../src/adapters/mirror-node.js";
import { RawGithubSourceAdapter } from "../src/adapters/source-raw-github.js";
import { silentLogger } from "../src/log.js";
import { SourceFetchError } from "../src/ports/index.js";

const tx = (over: Partial<MirrorTransaction> = {}): MirrorTransaction => ({
  consensus_timestamp: "1788848310.262244104",
  memo_base64: Buffer.from("a".repeat(64)).toString("base64"),
  name: "CRYPTOTRANSFER",
  result: "SUCCESS",
  transaction_id: "0.0.7162784-1788848300-493972399",
  transfers: [
    { account: "0.0.802", amount: 246_668 },
    { account: "0.0.7162784", amount: -246_668 },
    { account: "0.0.10405046", amount: -100_000 },
    { account: "0.0.4820", amount: 100_000 },
  ],
  ...over,
});

describe("mirror node id and payload handling", () => {
  it("converts the SDK transaction id to the dashed REST form", () => {
    // The SDK form returns HTTP 400 from the mirror node (B §3.4, C6).
    expect(toDashedTransactionId("0.0.4821@1725379200.123456789")).toBe(
      "0.0.4821-1725379200-123456789",
    );
  });

  it("leaves an already-dashed id alone", () => {
    expect(toDashedTransactionId("0.0.4821-1725379200-123456789")).toBe(
      "0.0.4821-1725379200-123456789",
    );
  });

  it("decodes the base64 memo", () => {
    expect(decodeMemo(tx().memo_base64)).toBe("a".repeat(64));
    expect(decodeMemo(null)).toBe("");
    expect(decodeMemo("")).toBe("");
  });

  it("nets the credit to the witness across the transfer list", () => {
    expect(creditedTo(tx(), "0.0.4820")).toBe(100_000n);
    expect(creditedTo(tx(), "0.0.9999")).toBe(0n);
  });

  it("retries while the transaction has not been ingested, then reports it missing", async () => {
    let calls = 0;
    const client = new MirrorNodeClient({
      baseUrl: "https://mirror.test",
      attempts: 3,
      delayMs: 0,
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: 404 });
      },
    });

    expect(await client.getTransaction("0.0.1@1.2")).toBeNull();
    expect(calls).toBe(3);
  });

  it("throws rather than reporting a missing transaction when the mirror is unwell", async () => {
    const client = new MirrorNodeClient({
      baseUrl: "https://mirror.test",
      attempts: 2,
      delayMs: 0,
      sleep: async () => {},
      fetchImpl: async () => new Response("boom", { status: 503 }),
    });

    await expect(client.getTransaction("0.0.1@1.2")).rejects.toThrow(/unreachable/);
  });

  it("returns the transaction once it appears", async () => {
    let calls = 0;
    const client = new MirrorNodeClient({
      baseUrl: "https://mirror.test",
      attempts: 3,
      delayMs: 0,
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response("{}", { status: 404 });
        return new Response(JSON.stringify({ transactions: [tx()] }), { status: 200 });
      },
    });

    const found = await client.getTransaction("0.0.1@1.2");
    expect(found?.[0]?.result).toBe("SUCCESS");
  });
});

describe("hedera timestamp formatting", () => {
  it("zero-pads nanos to nine digits", () => {
    expect(timestampToString({ seconds: 1_725_379_200n, nanos: 123n })).toBe(
      "1725379200.000000123",
    );
  });
});

describe("raw.githubusercontent source", () => {
  const adapter = (impl: typeof fetch) => new RawGithubSourceAdapter({ fetchImpl: impl });

  it("fetches at an immutable sha with no token", async () => {
    let seen = "";
    const source = adapter(async (url) => {
      seen = String(url);
      return new Response("policy bytes", { status: 200 });
    });

    const bytes = await source.fetch("org/repo", "a".repeat(40), "klaxon.policy.json");
    expect(bytes.toString()).toBe("policy bytes");
    expect(seen).toBe(
      `https://raw.githubusercontent.com/org/repo/${"a".repeat(40)}/klaxon.policy.json`,
    );
  });

  it("marks a 404 as not-found and anything else as an outage", async () => {
    const missing = adapter(async () => new Response("", { status: 404 }));
    await expect(missing.fetch("org/repo", "a", "x")).rejects.toMatchObject({ notFound: true });

    const broken = adapter(async () => new Response("", { status: 500 }));
    await expect(broken.fetch("org/repo", "a", "x")).rejects.toMatchObject({ notFound: false });
  });

  it("turns a transport failure into a SourceFetchError, never a silent empty read", async () => {
    const dead = adapter(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(dead.fetch("org/repo", "a", "x")).rejects.toBeInstanceOf(SourceFetchError);
  });
});

describe("ntfy alarm", () => {
  it("sends priority 5 with a HashScan click target and never throws", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const alarm = new NtfyAlarmAdapter(silentLogger, {
      baseUrl: "https://ntfy.sh",
      network: "testnet",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response("", { status: 200 });
      },
    });

    alarm.refused({
      topic: "klaxon-abc",
      secret: "DEPLOYER_PRIVATE_KEY",
      repository: "org/repo",
      runId: "481",
      runAttempt: "1",
      environment: "production",
      payTx: "0.0.4821@1.2",
      tinybars: "100000",
      class: "policy",
      check: 5,
      reason: "install step",
      revoked: true,
    });
    await new Promise((r) => setImmediate(r));

    expect(calls[0]?.url).toBe("https://ntfy.sh/klaxon-abc");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Priority).toBe("5");
    expect(headers.Tags).toBe("rotating_light,lock");
    expect(headers.Click).toBe("https://hashscan.io/testnet/transaction/0.0.4821@1.2");
    expect(String(calls[0]?.init.body)).toContain("Project revoked.");
  });

  it("swallows a push failure rather than turning a refusal into an error", async () => {
    const alarm = new NtfyAlarmAdapter(silentLogger, {
      baseUrl: "https://ntfy.sh",
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });

    expect(() =>
      alarm.refused({
        topic: "klaxon-abc",
        secret: "S",
        repository: "org/repo",
        runId: "1",
        runAttempt: "1",
        environment: "production",
        payTx: "0.0.1@1.2",
        tinybars: "100000",
        class: "auth",
        check: 3,
        reason: "claims mismatch",
        revoked: false,
      }),
    ).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });

  it("stays silent when no topic is configured", () => {
    const alarm = new NtfyAlarmAdapter(silentLogger, {
      baseUrl: "https://ntfy.sh",
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
    });
    expect(() =>
      alarm.refused({
        topic: null,
        secret: "S",
        repository: "org/repo",
        runId: "1",
        runAttempt: "1",
        environment: "production",
        payTx: "0.0.1@1.2",
        tinybars: "100000",
        class: "auth",
        check: 3,
        reason: "x",
        revoked: false,
      }),
    ).not.toThrow();
  });
});
