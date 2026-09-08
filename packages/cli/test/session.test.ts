import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { parseSession, requireTrustchain } from "../src/wallet-cli/session.js";

const FULL = `accounts:
  - { label: "ethereum_sepolia-1", descriptor: "abc" }
trustchain:
  rootId: "0xroot"
  applicationPath: "m/0'/16'/0'"
domains:
  - { domain: "klaxon/aa/S/1", firstUsed: "2026-09-08T00:00:00.000Z" }
passwordSalt: "00112233445566778899aabbccddeeff"
`;

describe("parseSession", () => {
  it("reads the shape wallet-cli 2.1.0 persists", () => {
    const s = parseSession(FULL);
    expect(s.trustchain).toEqual({ rootId: "0xroot", applicationPath: "m/0'/16'/0'" });
    expect(s.passwordSalt).toBe("00112233445566778899aabbccddeeff");
    expect(s.accounts[0]?.label).toBe("ethereum_sepolia-1");
    expect(s.domains).toHaveLength(1);
  });

  it("treats passwordSalt as optional — a plaintext keychain entry has no salt", () => {
    const s = parseSession('trustchain:\n  rootId: "r"\n  applicationPath: "m/1"\n');
    expect(s.passwordSalt).toBeUndefined();
    expect(s.accounts).toEqual([]);
  });

  it("rejects a salt that is not 16 bytes of lowercase hex", () => {
    expect(() => parseSession('passwordSalt: "NOTHEX"\n')).toThrowError(CliError);
    expect(() => parseSession(`passwordSalt: "${"a".repeat(30)}"\n`)).toThrowError(/passwordSalt/);
  });

  it("drops keys it does not model rather than failing on them", () => {
    const s = parseSession(`${FULL}somethingNew: 42\n`);
    expect(s).not.toHaveProperty("somethingNew");
  });

  it("accepts an empty file", () => {
    expect(parseSession("").accounts).toEqual([]);
  });

  it("rejects invalid YAML", () => {
    expect(() => parseSession("a:\n  - [unclosed\n")).toThrowError(CliError);
  });

  it("never carries a walletSyncEncryptionKey — wallet-cli strips it before writing", () => {
    const s = parseSession(`${FULL}walletSyncEncryptionKey: "deadbeef"\n`);
    expect(s).not.toHaveProperty("walletSyncEncryptionKey");
  });
});

describe("requireTrustchain", () => {
  it("explains what to run when the block is absent", () => {
    expect(() => requireTrustchain(parseSession("accounts: []\n"))).toThrowError(
      /wallet-cli ring init/,
    );
  });
});
