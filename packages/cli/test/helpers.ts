import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressedPubkeyHex, type KlaxonMember } from "@klaxon/core";
import type { CliDeps } from "../src/deps.js";

/** A fixed, valid secp256k1 key. Test-only; it protects nothing. */
export const TEST_PRIV = "b7f1c1a2b7c9d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d";
export const TEST_PUB = "035eab79e9ccc3edc1754dbf5490ddb528784fce267f5f0e59827ab801b5b30e99";
/** The operator key is deliberately a different key from the member key (PROTOCOL §2). */
export const TEST_OPERATOR_PRIV = "44".repeat(32);
export const TEST_OPERATOR_PUB = compressedPubkeyHex(TEST_OPERATOR_PRIV);
export const TEST_PAY_ACCOUNT = "0.0.5550001";
export const TEST_ROOT_ID = "0x0000000000000000000000000000000000000000000000000000000000001234";
export const TEST_APP_PATH = "m/0'/16'/0'";
export const TEST_WSEK = "9f".repeat(32);
export const TEST_PROJECT_ID = "a".repeat(64);
export const TEST_REGISTRY = "0x00000000000000000000000000000000000000ff";

export const TEST_MEMBER: KlaxonMember = {
  v: 1,
  rootId: TEST_ROOT_ID,
  applicationPath: TEST_APP_PATH,
  applicationId: 17,
  privatekey: TEST_PRIV,
  pubkey: TEST_PUB,
};

export function tempDir(prefix = "klaxon-cli-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  stdout(): string;
  stderr(): string;
}

/**
 * Every seam is faked by default. Nothing in the test suite may reach the real keychain, the
 * real `wallet-cli`, a device, Ledger's API or Hedera — a test that needs one overrides it here.
 */
export function makeHarness(overrides: Partial<CliDeps> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    env: {},
    cwd: tempDir("klaxon-cwd-"),
    home: tempDir("klaxon-home-"),
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
    isTty: () => false,
    now: () => new Date("2026-09-08T12:00:00.000Z"),
    keychain: async () => {
      throw new Error("test reached the real keychain");
    },
    runWalletCli: async () => {
      throw new Error("test reached the real wallet-cli");
    },
    fetchImpl: async () => {
      throw new Error("test reached the real network");
    },
    createTopic: async () => {
      throw new Error("test reached Hedera");
    },
    publishTopicMessage: async () => {
      throw new Error("test reached Hedera");
    },
    memoTransfer: async () => {
      throw new Error("test reached Hedera");
    },
    restoreWsek: async () => TEST_WSEK,
    readStdin: async () => Buffer.from("stdin not stubbed", "utf8"),
    randomHex: (bytes) => "5c".repeat(bytes),
    ...overrides,
  };
  return {
    deps,
    out,
    err,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

export interface ProjectFixtureArgs {
  home: string;
  witnessUrl?: string;
  name?: string;
}

/** Writes a `~/.klaxon/config.json` under a temp home so nothing touches the operator's own. */
export function writeProjectConfig(a: ProjectFixtureArgs): string {
  const dir = join(a.home, ".klaxon");
  mkdirSync(dir, { recursive: true });
  // Every laptop-side command that talks to the witness signs with this key, so the fixture has
  // to lay it down alongside the config the way `klaxon init` does.
  writeFileSync(join(dir, "operator.key"), `${TEST_OPERATOR_PRIV}\n`, { mode: 0o600 });
  const file = join(dir, "config.json");
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        version: 1,
        default_project: a.name ?? "demo",
        projects: {
          [a.name ?? "demo"]: {
            project_id: TEST_PROJECT_ID,
            repository: "acme/demo",
            repository_id: "123456789",
            trustchain_root_id: TEST_ROOT_ID,
            application_path: TEST_APP_PATH,
            application_id: 17,
            witness_url: a.witnessUrl ?? "https://witness.example",
            topic_id: "0.0.48213",
            registry_address: TEST_REGISTRY,
            chain_id: 11155111,
            hedera_account: "0.0.9999",
            hedera_network: "testnet",
            member_pubkey: TEST_PUB,
            operator_pubkey: TEST_OPERATOR_PUB,
            pay_account: TEST_PAY_ACCOUNT,
            last_epoch: 0,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

/** A `session.yaml` under a fake `stateDir`, with the trustchain block `loadMember` needs. */
export function writeSession(stateDir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(stateDir, { recursive: true });
  const doc = {
    accounts: [{ label: "ethereum_sepolia-1", descriptor: "xpub..." }],
    trustchain: { rootId: TEST_ROOT_ID, applicationPath: TEST_APP_PATH },
    domains: [],
    ...extra,
  };
  writeFileSync(join(stateDir, "session.yaml"), toYaml(doc));
}

function toYaml(doc: Record<string, unknown>): string {
  // Deliberately hand-rolled: the parser under test should not be fed its own serializer.
  const lines: string[] = [];
  for (const [k, v] of Object.entries(doc)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${JSON.stringify(item)}`);
      if (v.length === 0) lines[lines.length - 1] = `${k}: []`;
    } else if (v && typeof v === "object") {
      lines.push(`${k}:`);
      for (const [ik, iv] of Object.entries(v)) lines.push(`  ${ik}: ${JSON.stringify(iv)}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** A `fetch` stand-in that answers a fixed route table and records what it was asked. */
export interface FakeFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
}

export function fakeFetch(
  routes: Record<string, (call: FakeFetchCall) => { status?: number; json: unknown }>,
): { impl: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    const call: FakeFetchCall = { url, method: init?.method ?? "GET", headers, body };
    calls.push(call);
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return new Response("not found", { status: 404 });
    const { status = 200, json } = route(call);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
