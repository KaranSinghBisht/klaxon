import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { b64u, joinShares, openSecret, parseEncFile, ringDecrypt, shareHash } from "@klaxon/core";
import { describe, expect, it } from "vitest";
import { runWriteSecret } from "../src/commands/add.js";
import { encFilePath, keychainAccount } from "../src/config/paths.js";
import type { CliDeps } from "../src/deps.js";
import {
  fakeFetch,
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
const SHARE_B = Buffer.alloc(32, 0x5a);
const B_HASH = shareHash(SHARE_B);

interface Bench {
  deps: CliDeps;
  cwd: string;
  calls: ReturnType<typeof fakeFetch>["calls"];
  stdout: () => string;
}

function bench(routeOverrides: Parameters<typeof fakeFetch>[0] = {}): Bench {
  const home = tempDir("klaxon-home-");
  const cwd = tempDir("klaxon-repo-");
  const xdg = join(home, "state");
  const dir = join(xdg, "ledger-wallet-cli");
  writeSession(dir);
  writeProjectConfig({ home });
  const share = () => ({ json: { ok: true, b: b64u.encode(SHARE_B), b_hash: B_HASH } });
  const { impl, calls } = fakeFetch({ "/shares": share, "/rotate": share, ...routeOverrides });
  const h = makeHarness({
    home,
    cwd,
    env: { XDG_STATE_HOME: xdg },
    keychain: async (_s, account) => (account === keychainAccount(dir) ? TEST_PRIV : null),
    fetchImpl: impl,
    restoreWsek: async () => TEST_WSEK,
    readStdin: async () => Buffer.from(`${PLAINTEXT}\n`, "utf8"),
  });
  return { deps: h.deps, cwd, calls, stdout: h.stdout };
}

function readEnc(cwd: string, name = NAME) {
  return parseEncFile(JSON.parse(readFileSync(encFilePath(cwd, name), "utf8")));
}

describe("add", () => {
  it("writes a .enc whose a_ct the Key Ring opens and whose shares rebuild the secret", async () => {
    const b = bench();
    await runWriteSecret(b.deps, NAME, {}, "add");

    const enc = readEnc(b.cwd);
    expect(enc.klaxon).toBe(1);
    expect(enc.project_id).toBe(TEST_PROJECT_ID);
    expect(enc.gen).toBe("1");
    expect(enc.a_key_name).toBe(`klaxon/${TEST_PROJECT_ID}/${NAME}/1`);
    expect(enc.alg).toEqual({
      aead: "AES-256-GCM",
      split: "xor-2of2",
      share_a: "lkrp-wallet-cli-domain-v1",
      application_id: 17,
    });
    expect(enc.b_hash).toBe(B_HASH);

    // Share A is byte-compatible with `wallet-cli ring decrypt --key <a_key_name>` (D2).
    const shareA = ringDecrypt(TEST_WSEK, enc.a_key_name, b64u.decode(enc.a_ct));
    expect(shareA).toHaveLength(32);
    const dk = joinShares(shareA, SHARE_B);
    const recovered = openSecret(dk, enc.ct, {
      project_id: enc.project_id,
      secret: enc.secret,
      gen: enc.gen,
    });
    expect(recovered.toString("utf8")).toBe(PLAINTEXT);
  });

  it("never puts the plaintext, the data key or share B in the file", async () => {
    const b = bench();
    await runWriteSecret(b.deps, NAME, {}, "add");
    const raw = readFileSync(encFilePath(b.cwd, NAME), "utf8");
    expect(raw).not.toContain(PLAINTEXT);
    expect(raw).not.toContain(SHARE_B.toString("base64url"));
    expect(raw).not.toContain(TEST_WSEK);
    expect(b.stdout()).not.toContain(PLAINTEXT);
  });

  it("strips one trailing newline from stdin unless --raw", async () => {
    const plain = bench();
    await runWriteSecret(plain.deps, NAME, {}, "add");
    const encA = readEnc(plain.cwd);
    const dkA = joinShares(
      ringDecrypt(TEST_WSEK, encA.a_key_name, b64u.decode(encA.a_ct)),
      SHARE_B,
    );
    expect(
      openSecret(dkA, encA.ct, { project_id: encA.project_id, secret: NAME, gen: "1" }).length,
    ).toBe(PLAINTEXT.length);

    const raw = bench();
    await runWriteSecret(raw.deps, NAME, { raw: true }, "add");
    const encB = readEnc(raw.cwd);
    const dkB = joinShares(
      ringDecrypt(TEST_WSEK, encB.a_key_name, b64u.decode(encB.a_ct)),
      SHARE_B,
    );
    expect(
      openSecret(dkB, encB.ct, { project_id: encB.project_id, secret: NAME, gen: "1" }).toString(),
    ).toBe(`${PLAINTEXT}\n`);
  });

  it("asks the witness for B over the member-signed channel", async () => {
    const b = bench();
    await runWriteSecret(b.deps, NAME, {}, "add");
    const call = b.calls[0];
    if (!call) throw new Error("no request recorded");
    expect(new URL(call.url).pathname).toBe("/shares");
    expect(call.headers["x-klaxon-member-sig"]).toBeTruthy();
    expect(JSON.parse(call.body.toString("utf8"))).toEqual({
      project_id: TEST_PROJECT_ID,
      secret: NAME,
      gen: "1",
    });
  });

  it("refuses to overwrite an existing generation", async () => {
    const b = bench();
    await runWriteSecret(b.deps, NAME, {}, "add");
    await expect(runWriteSecret(b.deps, NAME, {}, "add")).rejects.toThrowError(/klaxon rotate/);
  });

  it("refuses an empty secret and a badly named one", async () => {
    const b = bench();
    b.deps.readStdin = async () => Buffer.alloc(0);
    await expect(runWriteSecret(b.deps, NAME, {}, "add")).rejects.toThrowError(/empty secret/);
    await expect(runWriteSecret(b.deps, "lower_case", {}, "add")).rejects.toThrowError(
      /secret name must match/,
    );
  });

  it("refuses to write when the witness's b_hash disagrees with the share it sent", async () => {
    const b = bench({
      "/shares": () => ({ json: { ok: true, b: b64u.encode(SHARE_B), b_hash: "d".repeat(64) } }),
    });
    await expect(runWriteSecret(b.deps, NAME, {}, "add")).rejects.toThrowError(/b_hash/);
  });

  it("b_hash is sha256 of the share the witness returned", async () => {
    const b = bench();
    await runWriteSecret(b.deps, NAME, {}, "add");
    expect(readEnc(b.cwd).b_hash).toBe(createHash("sha256").update(SHARE_B).digest("hex"));
  });
});

describe("rotate", () => {
  it("moves to the next generation and re-keys share A under the new key name", async () => {
    const b = bench();
    await runWriteSecret(b.deps, NAME, {}, "add");
    const first = readEnc(b.cwd);
    await runWriteSecret(b.deps, NAME, {}, "rotate");
    const second = readEnc(b.cwd);

    expect(second.gen).toBe("2");
    expect(second.a_key_name).toBe(`klaxon/${TEST_PROJECT_ID}/${NAME}/2`);
    expect(second.a_ct).not.toBe(first.a_ct);
    expect(new URL((b.calls[1] as { url: string }).url).pathname).toBe("/rotate");
    // A gen-1 key must not open a gen-2 blob.
    expect(() => ringDecrypt(TEST_WSEK, first.a_key_name, b64u.decode(second.a_ct))).toThrowError();
  });

  it("refuses to rotate something that was never added", async () => {
    const b = bench();
    await expect(runWriteSecret(b.deps, NAME, {}, "rotate")).rejects.toThrowError(/klaxon add/);
  });
});
