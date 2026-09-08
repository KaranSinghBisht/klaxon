import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import {
  ENC_PREFIX,
  PASSWORD_SALT_BYTES,
  PBKDF2_ITERATIONS,
  parseKeychainValue,
  resolvePrivateKey,
  unwrapEncLine,
  wrapEncLine,
} from "../src/wallet-cli/keychain.js";
import { TEST_PRIV, TEST_PUB } from "./helpers.js";

const SALT = "00112233445566778899aabbccddeeff";
const PASS = "correct horse battery staple";

/**
 * Built from the documented steps (A §3.3) rather than from `wrapEncLine`, so the unwrap is
 * checked against the specification and not against its own inverse:
 *   key   = PBKDF2-HMAC-SHA256(utf8(WALLET_PASS), hexToBytes(passwordSalt), 600000, 32)
 *   value = "ENC:" + hex(iv(12) || ct || tag(16))
 */
function fixtureEncLine(privHex: string, pass = PASS, saltHex = SALT): string {
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

describe("constants read out of the wallet-cli binary", () => {
  it("pins the iteration count and salt length", () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    expect(PASSWORD_SALT_BYTES).toBe(16);
    expect(ENC_PREFIX).toBe("ENC:");
  });
});

describe("parseKeychainValue", () => {
  it("splits on \\r?\\n and trims, the way wallet-cli's own reader does", () => {
    expect(parseKeychainValue(`${TEST_PRIV}\r\n${TEST_PUB}\r\n`)).toEqual({
      line0: TEST_PRIV,
      line1: TEST_PUB,
    });
  });

  it("treats a one-line value as a private key with no public key", () => {
    expect(parseKeychainValue(`  ${TEST_PRIV}  `)).toEqual({ line0: TEST_PRIV, line1: undefined });
  });

  it("refuses an empty entry", () => {
    expect(() => parseKeychainValue("   \n  ")).toThrowError(CliError);
  });
});

describe("unwrapEncLine", () => {
  it("opens a fixture built from the documented PBKDF2/GCM steps", () => {
    expect(unwrapEncLine(fixtureEncLine(TEST_PRIV), PASS, SALT)).toBe(TEST_PRIV);
  });

  it("fails closed on the wrong WALLET_PASS", () => {
    expect(() => unwrapEncLine(fixtureEncLine(TEST_PRIV), "wrong", SALT)).toThrowError(
      /failed authentication/,
    );
  });

  it("fails closed on the wrong salt", () => {
    expect(() => unwrapEncLine(fixtureEncLine(TEST_PRIV), PASS, "ff".repeat(16))).toThrowError(
      CliError,
    );
  });

  it("rejects a salt that is not 32 lowercase hex characters", () => {
    expect(() => unwrapEncLine(fixtureEncLine(TEST_PRIV), PASS, "zz")).toThrowError(/passwordSalt/);
  });

  it("rejects a payload too short to be iv‖ct‖tag", () => {
    expect(() => unwrapEncLine(`ENC:${"00".repeat(20)}`, PASS, SALT)).toThrowError(/too short/);
  });

  it("rejects a plaintext that is not a 32-byte private key", () => {
    expect(() => unwrapEncLine(fixtureEncLine("not-a-key"), PASS, SALT)).toThrowError(
      /not a 32-byte private key/,
    );
  });
});

describe("wrapEncLine", () => {
  it("round-trips and draws a fresh salt each time", () => {
    const a = wrapEncLine(TEST_PRIV, PASS);
    const b = wrapEncLine(TEST_PRIV, PASS);
    expect(a.passwordSalt).not.toBe(b.passwordSalt);
    expect(a.passwordSalt).toMatch(/^[0-9a-f]{32}$/);
    expect(unwrapEncLine(a.line0, PASS, a.passwordSalt)).toBe(TEST_PRIV);
  });
});

describe("resolvePrivateKey", () => {
  it("passes a raw hex line straight through", () => {
    expect(
      resolvePrivateKey({
        value: { line0: TEST_PRIV, line1: undefined },
        walletPass: undefined,
        passwordSalt: undefined,
      }),
    ).toBe(TEST_PRIV);
  });

  it("rejects a line that is neither ENC: nor 64-hex", () => {
    expect(() =>
      resolvePrivateKey({
        value: { line0: "hello", line1: undefined },
        walletPass: undefined,
        passwordSalt: undefined,
      }),
    ).toThrowError(/neither ENC:/);
  });

  it("names WALLET_PASS when the entry is wrapped and the env is not set", () => {
    expect(() =>
      resolvePrivateKey({
        value: { line0: fixtureEncLine(TEST_PRIV), line1: undefined },
        walletPass: undefined,
        passwordSalt: SALT,
      }),
    ).toThrowError(/WALLET_PASS/);
  });

  it("names passwordSalt when session.yaml has none", () => {
    expect(() =>
      resolvePrivateKey({
        value: { line0: fixtureEncLine(TEST_PRIV), line1: undefined },
        walletPass: PASS,
        passwordSalt: undefined,
      }),
    ).toThrowError(/passwordSalt/);
  });
});
