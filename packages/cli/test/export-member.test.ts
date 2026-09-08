import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { join } from "node:path";
import { decodeMember, memberPublicKeyHex } from "@klaxon/core";
import { describe, expect, it } from "vitest";
import { runExportMember } from "../src/commands/export-member.js";
import { KEYCHAIN_SERVICE, keychainAccount } from "../src/config/paths.js";
import type { KeychainReader } from "../src/wallet-cli/keychain.js";
import {
  makeHarness,
  TEST_APP_PATH,
  TEST_PRIV,
  TEST_PUB,
  TEST_ROOT_ID,
  tempDir,
  writeSession,
} from "./helpers.js";

const SALT = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const PASS = "shoot-day";

function encLine(privHex: string, pass = PASS, saltHex = SALT): string {
  const key = pbkdf2Sync(
    Buffer.from(pass, "utf8"),
    Buffer.from(saltHex, "hex"),
    600_000,
    32,
    "sha256",
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(privHex, "utf8"), cipher.final()]);
  return `ENC:${Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("hex")}`;
}

/** Answers only for the exact service/account pair the command is supposed to ask for. */
function fakeKeychain(dir: string, value: string): { reader: KeychainReader; asked: string[] } {
  const asked: string[] = [];
  const reader: KeychainReader = async (service, account) => {
    asked.push(`${service}/${account}`);
    return service === KEYCHAIN_SERVICE && account === keychainAccount(dir) ? value : null;
  };
  return { reader, asked };
}

function setup(value: string, sessionExtra: Record<string, unknown> = {}) {
  const home = tempDir("klaxon-home-");
  const xdg = join(home, "state");
  const dir = join(xdg, "ledger-wallet-cli");
  writeSession(dir, sessionExtra);
  const { reader, asked } = fakeKeychain(dir, value);
  const h = makeHarness({
    home,
    env: { XDG_STATE_HOME: xdg, WALLET_PASS: PASS },
    keychain: reader,
  });
  return { h, dir, asked };
}

describe("export-member", () => {
  it("emits one base64 line that decodeMember accepts, deriving the pubkey when line 1 is absent", async () => {
    const { h, dir, asked } = setup(TEST_PRIV);
    await runExportMember(h.deps, {});

    const lines = h.stdout().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const member = decodeMember(lines[0] as string);
    expect(member).toEqual({
      v: 1,
      rootId: TEST_ROOT_ID,
      applicationPath: TEST_APP_PATH,
      applicationId: 17,
      privatekey: TEST_PRIV,
      pubkey: memberPublicKeyHex(TEST_PRIV),
    });
    expect(member.pubkey).toBe(TEST_PUB);
    expect(asked).toEqual([`${KEYCHAIN_SERVICE}/${keychainAccount(dir)}`]);
  });

  it("uses the stored public key when the entry has a second line", async () => {
    const { h } = setup(`${TEST_PRIV}\n${TEST_PUB.toUpperCase()}\n`);
    await runExportMember(h.deps, {});
    expect(decodeMember(h.stdout().trim()).pubkey).toBe(TEST_PUB);
  });

  it("unwraps an ENC: entry with WALLET_PASS and the session salt", async () => {
    const { h } = setup(encLine(TEST_PRIV), { passwordSalt: SALT });
    await runExportMember(h.deps, {});
    expect(decodeMember(h.stdout().trim()).privatekey).toBe(TEST_PRIV);
  });

  it("says which piece is missing when session.yaml has no passwordSalt", async () => {
    const { h } = setup(encLine(TEST_PRIV));
    await expect(runExportMember(h.deps, {})).rejects.toThrowError(/passwordSalt/);
  });

  it("says which piece is missing when WALLET_PASS is unset", async () => {
    const { h } = setup(encLine(TEST_PRIV), { passwordSalt: SALT });
    h.deps.env.WALLET_PASS = undefined;
    await expect(runExportMember(h.deps, {})).rejects.toThrowError(/WALLET_PASS/);
  });

  it("points at ring init when there is no keychain entry at all", async () => {
    const { h } = setup(TEST_PRIV);
    h.deps.keychain = async () => null;
    await expect(runExportMember(h.deps, {})).rejects.toThrowError(/wallet-cli ring init/);
  });

  it("--wrap re-wraps under a fresh salt and warns that the action cannot read it", async () => {
    const { h } = setup(TEST_PRIV);
    await runExportMember(h.deps, { wrap: true });

    const wrapped = JSON.parse(Buffer.from(h.stdout().trim(), "base64").toString("utf8"));
    expect(wrapped.wrapped).toBe(true);
    expect(wrapped.privatekey.startsWith("ENC:")).toBe(true);
    expect(wrapped.passwordSalt).toMatch(/^[0-9a-f]{32}$/);
    expect(wrapped.passwordSalt).not.toBe(SALT);
    expect(wrapped.pubkey).toBe(TEST_PUB);
    expect(h.stderr()).toMatch(/not consumable by the shipped action/);
    // D3: the plaintext path is the default precisely because this one is not decodeMember-able.
    expect(() => decodeMember(h.stdout().trim())).toThrowError();
  });

  it("--wrap without WALLET_PASS fails rather than emitting anything", async () => {
    const { h } = setup(TEST_PRIV);
    h.deps.env.WALLET_PASS = undefined;
    await expect(runExportMember(h.deps, { wrap: true })).rejects.toThrowError(/WALLET_PASS/);
    expect(h.stdout()).toBe("");
  });

  it("refuses to write the credential to a file", async () => {
    const { h } = setup(TEST_PRIV);
    await expect(runExportMember(h.deps, { out: "member.json" })).rejects.toThrowError(
      /only accepts `-`/,
    );
  });
});
