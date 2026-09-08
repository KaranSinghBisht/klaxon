import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addSecret, clearSecretRegistry, serializeEncFile } from "@klaxon/core";
import { describe, expect, it } from "vitest";
import { loadTransport, runGet } from "../src/commands/get.js";
import { encDir, encFilePath, keychainAccount } from "../src/config/paths.js";
import type { CliDeps } from "../src/deps.js";
import {
  makeHarness,
  TEST_PRIV,
  TEST_PROJECT_ID,
  TEST_WSEK,
  tempDir,
  writeProjectConfig,
  writeSession,
} from "./helpers.js";

const NAME = "DEPLOYER_PRIVATE_KEY";
const PLAINTEXT = "0xf00dbabe-not-a-real-key";
const SHARE_B = Buffer.alloc(32, 0x3c);

/**
 * A stand-in for the action's x402 transport. It seals share B straight from D24's steps with
 * node built-ins only, so this file needs no imports and can be loaded from a temp directory the
 * way an operator's own `--transport` module would be.
 */
const FAKE_TRANSPORT = `
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from "node:crypto";
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const rawPub = (k) => { const d = k.export({ type: "spki", format: "der" }); return Buffer.from(d.subarray(d.length - 32)); };
export function createTransport({ env }) {
  const b = Buffer.from(env.FAKE_SHARE_B, "hex");
  return {
    async release(h, body) {
      const rPubRaw = Buffer.from(body.C.ephemeral_pub.enc, "base64url");
      const rPub = createPublicKey({ key: Buffer.concat([SPKI_X25519, rPubRaw]), format: "der", type: "spki" });
      const e = generateKeyPairSync("x25519");
      const ss = diffieHellman({ privateKey: e.privateKey, publicKey: rPub });
      const ePubRaw = rawPub(e.publicKey);
      const okm = Buffer.from(hkdfSync("sha256", ss, Buffer.concat([ePubRaw, rPubRaw]), Buffer.from("klaxon/ecies/v1|" + h, "utf8"), 44));
      const cipher = createCipheriv("aes-256-gcm", okm.subarray(0, 32), okm.subarray(32, 44));
      cipher.setAAD(Buffer.from(h, "utf8"));
      const ct = Buffer.concat([cipher.update(b), cipher.final()]);
      return {
        status: 200,
        payTx: "0.0.1234@1757332800.000000000",
        body: {
          ok: true,
          h,
          share_b: { v: 1, epk: ePubRaw.toString("base64url"), ct: ct.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") },
          hcs: { sequence_number: "12", consensus_timestamp: "1757332800.000000000" },
        },
      };
    },
  };
}
`;

function fakeJwt(claims: Record<string, string>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.${Buffer.from("sig").toString("base64url")}`;
}

interface Bench {
  deps: CliDeps;
  transportPath: string;
  audiences: string[];
}

function bench(claims: Record<string, string> = {}): Bench {
  const home = tempDir("klaxon-home-");
  const cwd = tempDir("klaxon-repo-");
  const xdg = join(home, "state");
  const dir = join(xdg, "ledger-wallet-cli");
  writeSession(dir);
  writeProjectConfig({ home });

  const enc = addSecret({
    projectId: TEST_PROJECT_ID,
    secret: NAME,
    gen: "1",
    plaintext: Buffer.from(PLAINTEXT, "utf8"),
    wsek: TEST_WSEK,
    shareB: SHARE_B,
  });
  mkdirSync(encDir(cwd), { recursive: true });
  writeFileSync(encFilePath(cwd, NAME), serializeEncFile(enc));

  const transportPath = join(tempDir("klaxon-transport-"), "transport.mjs");
  writeFileSync(transportPath, FAKE_TRANSPORT);

  const audiences: string[] = [];
  const jwt = fakeJwt({
    repository_id: "123456789",
    run_id: "42",
    run_attempt: "1",
    environment: "production",
    ...claims,
  });
  const h = makeHarness({
    home,
    cwd,
    env: {
      XDG_STATE_HOME: xdg,
      FAKE_SHARE_B: SHARE_B.toString("hex"),
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?x=1",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-token",
    },
    keychain: async (_s, account) => (account === keychainAccount(dir) ? TEST_PRIV : null),
    restoreWsek: async () => TEST_WSEK,
    fetchImpl: (async (input: string) => {
      audiences.push(new URL(String(input)).searchParams.get("audience") ?? "");
      return new Response(JSON.stringify({ value: jwt }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  return { deps: h.deps, transportPath, audiences };
}

describe("loadTransport", () => {
  it("accepts a createTransport export", async () => {
    const b = bench();
    const t = await loadTransport(
      b.transportPath,
      { witnessUrl: "https://w", env: b.deps.env, fetchImpl: b.deps.fetchImpl },
      b.deps.cwd,
    );
    expect(typeof t.release).toBe("function");
  });

  it("says so when the module does not exist or exports nothing usable", async () => {
    const b = bench();
    const args = { witnessUrl: "https://w", env: b.deps.env, fetchImpl: b.deps.fetchImpl };
    await expect(loadTransport("/nope/missing.mjs", args, b.deps.cwd)).rejects.toThrowError(
      /could not load transport module/,
    );
    const empty = join(tempDir(), "empty.mjs");
    writeFileSync(empty, "export const nothing = 1;\n");
    await expect(loadTransport(empty, args, b.deps.cwd)).rejects.toThrowError(
      /exports no createTransport/,
    );
  });
});

describe("get", () => {
  it("mints the probe token first, then one bound to h (D18)", async () => {
    const b = bench();
    await runGet(b.deps, NAME, { transport: b.transportPath });
    expect(b.audiences[0]).toBe("klaxon:probe");
    expect(b.audiences[1]).toMatch(/^klaxon:[0-9a-f]{64}$/);
  });

  it("recombines the two shares and prints the plaintext exactly once", async () => {
    const b = bench();
    const written: string[] = [];
    b.deps.stdout = (s) => void written.push(s);
    await runGet(b.deps, NAME, { transport: b.transportPath });
    expect(written.join("")).toBe(`${PLAINTEXT}\n`);
    expect(written.join("").split(PLAINTEXT)).toHaveLength(2);
  });

  it("emits ::add-mask:: lines before the value in CI", async () => {
    clearSecretRegistry();
    const home = bench();
    home.deps.env.GITHUB_ACTIONS = "true";
    const written: string[] = [];
    home.deps.stdout = (s) => void written.push(s);
    await runGet(home.deps, NAME, { transport: home.transportPath });

    const lines = written.join("").trimEnd().split("\n");
    expect(lines.at(-1)).toBe(PLAINTEXT);
    expect(lines.slice(0, -1).every((l) => l.startsWith("::add-mask::"))).toBe(true);
    expect(lines).toContain(`::add-mask::${PLAINTEXT}`);
  });

  it("does not print masks outside CI", async () => {
    const b = bench();
    const written: string[] = [];
    b.deps.stdout = (s) => void written.push(s);
    await runGet(b.deps, NAME, { transport: b.transportPath });
    expect(written.join("")).toBe(`${PLAINTEXT}\n`);
  });

  it("reports the commitment, the payment and the HCS message on stderr", async () => {
    const b = bench();
    const err: string[] = [];
    b.deps.stderr = (s) => void err.push(s);
    await runGet(b.deps, NAME, { transport: b.transportPath });
    expect(err.join("")).toMatch(/released h=[0-9a-f]{64} pay_tx=0\.0\.1234@/);
    expect(err.join("")).toContain("hcs=12@");
  });

  it("refuses a terminal without the flag", async () => {
    const b = bench();
    b.deps.isTty = () => true;
    await expect(runGet(b.deps, NAME, { transport: b.transportPath })).rejects.toThrowError(
      /terminal/,
    );
  });

  it("falls back to the sentinel when the token carries no environment claim", async () => {
    const b = bench({ environment: "" });
    await expect(runGet(b.deps, NAME, { transport: b.transportPath })).resolves.toBeUndefined();
  });

  it("says the .enc is missing rather than paying for nothing", async () => {
    const b = bench();
    await expect(
      runGet(b.deps, "OTHER_SECRET", { transport: b.transportPath }),
    ).rejects.toThrowError(/cannot read/);
  });
});
