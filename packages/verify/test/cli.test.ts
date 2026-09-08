import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { encodeEventTopics, numberToHex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POLICY_COMMITTED_EVENT } from "../src/registry.js";
import {
  POLICY_HASH,
  PROJECT_ID,
  payment,
  REGISTRY,
  TOPIC_ID,
  topicMessage,
  WITNESS,
} from "./helpers/scenario.js";

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

const POLICY_BLOCK = 8_999_000n;
const HEAD = 9_000_000n;

/** Stands in for both the mirror node and a Sepolia JSON-RPC, so the CLI test needs no network. */
function rpcResult(method: string, params: unknown[]): unknown {
  switch (method) {
    case "eth_chainId":
      return numberToHex(11155111);
    case "eth_blockNumber":
      return numberToHex(HEAD);
    case "eth_getLogs": {
      const filter = params[0] as { fromBlock: string; toBlock: string };
      if (BigInt(filter.fromBlock) > POLICY_BLOCK || BigInt(filter.toBlock) < POLICY_BLOCK)
        return [];
      return [
        {
          address: REGISTRY,
          topics: encodeEventTopics({
            abi: [POLICY_COMMITTED_EVENT],
            eventName: "PolicyCommitted",
            args: { p: `0x${PROJECT_ID}` },
          }),
          data: `0x${POLICY_HASH}`,
          blockNumber: numberToHex(POLICY_BLOCK),
          blockHash: `0x${"1".repeat(64)}`,
          transactionHash: `0x${"2".repeat(64)}`,
          transactionIndex: "0x0",
          logIndex: "0x0",
          removed: false,
        },
      ];
    }
    case "eth_getBlockByNumber":
      return {
        number: numberToHex(POLICY_BLOCK),
        hash: `0x${"1".repeat(64)}`,
        parentHash: `0x${"0".repeat(64)}`,
        timestamp: numberToHex(1_788_000_000),
        gasLimit: "0x0",
        gasUsed: "0x0",
        miner: `0x${"0".repeat(40)}`,
        extraData: "0x",
        transactions: [],
        uncles: [],
      };
    default:
      throw new Error(`unexpected RPC method ${method}`);
  }
}

interface Fixtures {
  messages: unknown[];
  transactions: unknown[];
}

let server: Server;
let base: string;
const state: Fixtures = { messages: [], transactions: [] };

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as
          | { id: number; method: string; params: unknown[] }
          | { id: number; method: string; params: unknown[] }[];
        const answer = (one: { id: number; method: string; params: unknown[] }) => ({
          jsonrpc: "2.0",
          id: one.id,
          result: rpcResult(one.method, one.params ?? []),
        });
        const out = Array.isArray(parsed) ? parsed.map(answer) : answer(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
      return;
    }
    const body = url.pathname.includes("/messages")
      ? { messages: state.messages, links: { next: null } }
      : { transactions: state.transactions, links: { next: null } };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [BIN, ...args], { cwd: PACKAGE_DIR });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function baseArgs(): string[] {
  return [
    "--topic",
    TOPIC_ID,
    "--witness",
    WITNESS,
    "--registry",
    REGISTRY,
    "--mirror",
    base,
    "--rpc",
    base,
    "--from-block",
    String(POLICY_BLOCK - 10n),
    "--grace",
    "0",
  ];
}

describe("klaxon-verify CLI", () => {
  it("prints the help text and exits clean", async () => {
    const run = await runCli(["--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("klaxon-verify --topic 0.0.X --witness 0.0.Y --registry 0xREG");
  });

  it("exits 2 when required flags are missing", async () => {
    const run = await runCli(["--topic", TOPIC_ID]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--topic, --witness and --registry are all required");
  });

  it("exits 2 on an unparseable flag", async () => {
    const run = await runCli([...baseArgs(), "--nope"]);
    expect(run.code).toBe(2);
  });

  it("exits 0 on a clean topic, reading the registry over real JSON-RPC", async () => {
    // A jwks snapshot alone: nothing to check, but it names the project the timeline is for.
    state.messages = [
      topicMessage(
        {
          klaxon: 1,
          type: "jwks",
          ts: "2026-09-09T00:00:00.000Z",
          project_id: PROJECT_ID,
          keys: [{ kid: "gh-2026-09", kty: "RSA" }],
        },
        "1788848300.000000000",
      ),
    ];
    state.transactions = [];
    const run = await runCli(baseArgs());
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("VIOLATIONS 0");
    expect(run.stdout).toContain("(1 policy version on Sepolia)");
  });

  it("exits 1 and names the withheld payment", async () => {
    state.messages = [];
    state.transactions = [
      payment("9".repeat(64), "1788848330.000000000", "0.0.10405046-1788848302-000000003"),
    ];
    const run = await runCli(baseArgs());
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("WITNESS WITHHELD");
    expect(run.stdout).toContain("VIOLATIONS 1");
  });

  it("emits a machine-readable report under --json", async () => {
    const run = await runCli([...baseArgs(), "--json"]);
    expect(run.code).toBe(1);
    const report = JSON.parse(run.stdout) as {
      klaxon_verify: number;
      counts: { withheld: number };
      violations: number;
    };
    expect(report.klaxon_verify).toBe(1);
    expect(report.counts.withheld).toBe(1);
    expect(report.violations).toBe(1);
  });

  it("exits 2 when the mirror node cannot be reached", async () => {
    const run = await runCli([
      "--topic",
      TOPIC_ID,
      "--witness",
      WITNESS,
      "--registry",
      REGISTRY,
      "--mirror",
      "http://127.0.0.1:1",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("mirror node unreachable");
  }, 30_000);
});
