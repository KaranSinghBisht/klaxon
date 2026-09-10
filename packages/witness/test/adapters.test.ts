import { describe, expect, it } from "vitest";
import { NtfyAlarmAdapter } from "../src/adapters/alarm-ntfy.js";
import { timestampToString } from "../src/adapters/hcs-hedera.js";
import {
  creditedTo,
  decodeMemo,
  MirrorNodeClient,
  type MirrorTransaction,
  MirrorUnavailableError,
  toDashedTransactionId,
} from "../src/adapters/mirror-node.js";
import { X402PaymentAdapter } from "../src/adapters/payment-x402.js";
import { RawGithubSourceAdapter } from "../src/adapters/source-raw-github.js";
import { loadEnv } from "../src/env.js";
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

/**
 * An upstream that accepts the connection and then says nothing at all, which is the shape that
 * hurts: undici waits 300 s for headers by default, so without a deadline of our own one slow host
 * pins a Fastify connection for five minutes. The recorded signal is the assertion.
 */
function fetchThatNeverAnswers(signals: (AbortSignal | undefined)[]): typeof fetch {
  return ((_url: unknown, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      // A caller with no deadline would wait here until undici gave up; rather than hold the suite
      // for that long the fake fails straight away and the recorded signal carries the verdict.
      if (!signal) return reject(new Error("call was made with no deadline"));
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  }) as typeof fetch;
}

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

  it("puts a deadline on the read and calls a mirror that never answers unreachable", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const client = new MirrorNodeClient({
      baseUrl: "https://mirror.test",
      attempts: 1,
      delayMs: 0,
      timeoutMs: 5,
      sleep: async () => {},
      fetchImpl: fetchThatNeverAnswers(signals),
    });

    // Fail closed: an outage is an outage, never "the payment is not there" (check 1 reads `infra`).
    await expect(client.getTransaction("0.0.1@1.2")).rejects.toBeInstanceOf(MirrorUnavailableError);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(true);
    expect((signals[0]?.reason as Error | undefined)?.name).toBe("TimeoutError");
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

  it("puts a deadline on the read and calls a hung GitHub an outage, not a missing file", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const source = new RawGithubSourceAdapter({
      timeoutMs: 5,
      fetchImpl: fetchThatNeverAnswers(signals),
    });

    // `notFound: false` is the whole point: a timeout must never read as "policy absent", which is
    // a verdict, when it is an outage. Check 5 sits on the release critical path.
    await expect(
      source.fetch("org/repo", "a".repeat(40), "klaxon.policy.json"),
    ).rejects.toMatchObject({ notFound: false });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect((signals[0]?.reason as Error | undefined)?.name).toBe("TimeoutError");
  });
});

/**
 * `/health` is the signal Fly routes on. Reporting a flag latched by `initialize()` at boot would
 * keep a machine in rotation with Blocky402 dead underneath — a witness advertising a 402 it
 * cannot settle — which is exactly the failure the endpoint exists to catch (PROTOCOL §2).
 */
describe("x402 facilitator health", () => {
  const config = loadEnv({
    KLAXON_PUBLIC_URL: "https://witness.test",
    WITNESS_MASTER: "5a".repeat(32),
    HEDERA_OPERATOR_ID: "0.0.4820",
    HEDERA_OPERATOR_KEY: "0xdeadbeef",
    KLAXON_REGISTRY: "0x1111111111111111111111111111111111111111",
    X402_FACILITATOR: "https://facilitator.test",
  });

  /** A mirror that is always up, so these assertions are about the facilitator alone. */
  const upMirror = (): MirrorNodeClient =>
    new MirrorNodeClient({
      baseUrl: "https://mirror.test",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });

  it("probes /supported live and goes red when the facilitator dies under a running witness", async () => {
    const urls: string[] = [];
    let status = 200;
    const adapter = new X402PaymentAdapter(config, silentLogger, upMirror(), {
      probeTtlMs: 0,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response("{}", { status });
      },
    });

    expect(await adapter.health()).toEqual({ facilitator: true, mirror: true });
    expect(urls[0]).toBe("https://facilitator.test/supported");

    // Same adapter, no restart and no second `initialize()` — only the upstream has changed. A
    // boot flag would still be answering `true` here.
    status = 503;
    expect(await adapter.health()).toMatchObject({ facilitator: false });
  });

  it("reports a facilitator that never answers as down rather than hanging /health", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const adapter = new X402PaymentAdapter(config, silentLogger, upMirror(), {
      timeoutMs: 5,
      fetchImpl: fetchThatNeverAnswers(signals),
    });

    expect(await adapter.health()).toMatchObject({ facilitator: false });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect((signals[0]?.reason as Error | undefined)?.name).toBe("TimeoutError");
  });

  it("caches the probe briefly so a health check never becomes a load generator", async () => {
    let calls = 0;
    let now = 1_000_000;
    const adapter = new X402PaymentAdapter(config, silentLogger, upMirror(), {
      probeTtlMs: 5_000,
      now: () => now,
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
    });

    await adapter.health();
    await adapter.health();
    expect(calls).toBe(1);

    now += 5_001;
    await adapter.health();
    expect(calls).toBe(2);
  });
});

describe("x402 on-chain verification", () => {
  const config = loadEnv({
    KLAXON_PUBLIC_URL: "https://witness.test",
    WITNESS_MASTER: "5a".repeat(32),
    HEDERA_OPERATOR_ID: "0.0.4820",
    HEDERA_OPERATOR_KEY: "0xdeadbeef",
    KLAXON_REGISTRY: "0x1111111111111111111111111111111111111111",
    X402_FACILITATOR: "https://facilitator.test",
  });

  it("names the runner as payer, not the facilitator that paid the bigger network fee", async () => {
    // Gate B's real shape: Blocky402 (the fee payer) is debited MORE than the runner, so reading
    // the "most negative" debit would name the facilitator the payer — and check 1 would then
    // refuse a legitimate release whose registered pay account is the runner. Match the credit.
    const mirror = new MirrorNodeClient({
      baseUrl: "https://mirror.test",
      fetchImpl: async () =>
        new Response(JSON.stringify({ transactions: [tx()] }), { status: 200 }),
    });
    const adapter = new X402PaymentAdapter(config, silentLogger, mirror);
    const outcome = await adapter.verifySettledOnChain("0.0.7162784@1.2", {
      memo: "a".repeat(64),
      toAccount: "0.0.4820",
      minAmount: "100000",
    });
    // 0.0.10405046 is the runner (-100000); 0.0.7162784 is Blocky402's -246668 fee debit.
    expect(outcome).toMatchObject({ ok: true, payerAccount: "0.0.10405046", amount: "100000" });
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

  it("sends a release receipt quietly, below the priority of a refusal", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const alarm = new NtfyAlarmAdapter(silentLogger, {
      baseUrl: "https://ntfy.sh",
      network: "testnet",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response("", { status: 200 });
      },
    });

    alarm.released({
      topic: "klaxon-abc",
      secret: "DEPLOYER_PRIVATE_KEY",
      environment: "production",
      repository: "org/repo",
      workflowRef: "org/repo/.github/workflows/deploy.yml@refs/heads/main",
      runId: "481",
      runAttempt: "1",
      h: "a".repeat(64),
      payTx: "0.0.4821@1.2",
      tinybars: "100000",
    });
    await new Promise((r) => setImmediate(r));

    const headers = calls[0]?.init.headers as Record<string, string>;
    // Strictly quieter than a refusal's 5. This is the whole point of having two methods: a
    // receipt that shouts as loudly as an alarm makes the operator ignore the alarm.
    expect(Number(headers.Priority)).toBeLessThan(5);
    expect(headers.Title).toBe("KLAXON released DEPLOYER_PRIVATE_KEY");
    expect(headers.Tags).not.toContain("rotating_light");
    expect(headers.Click).toBe("https://hashscan.io/testnet/transaction/0.0.4821@1.2");

    const body = String(calls[0]?.init.body);
    expect(body).toContain("DEPLOYER_PRIVATE_KEY → production");
    expect(body).toContain("org/repo/.github/workflows/deploy.yml@refs/heads/main");
    expect(body).toContain(`h ${"a".repeat(64)}`); // the handle for the topic lookup
    expect(body).not.toContain("Refused");
  });

  it("stays silent on a release when no topic is configured", () => {
    const alarm = new NtfyAlarmAdapter(silentLogger, {
      baseUrl: "https://ntfy.sh",
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
    });
    expect(() =>
      alarm.released({
        topic: null,
        secret: "S",
        environment: "production",
        repository: "org/repo",
        workflowRef: "org/repo/.github/workflows/deploy.yml@refs/heads/main",
        runId: "1",
        runAttempt: "1",
        h: "b".repeat(64),
        payTx: "0.0.1@1.2",
        tinybars: "100000",
      }),
    ).not.toThrow();
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
