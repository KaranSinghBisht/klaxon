import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { CliError } from "../errors.js";

/** Literal constants in the wallet-cli 2.1.0 binary (`rkD`, `ekD`) — A §3.3. */
export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_KEY_BYTES = 32;
export const PASSWORD_SALT_BYTES = 16;
export const ENC_PREFIX = "ENC:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Reads one OS keychain entry. Injected so tests never touch the real macOS keychain. */
export type KeychainReader = (service: string, account: string) => Promise<string | null>;

/**
 * The real reader. `@napi-rs/keyring` is loaded lazily: it is a native addon, and nothing but the
 * operator-facing commands should ever pull it into the process.
 */
export const systemKeychain: KeychainReader = async (service, account) => {
  const { Entry } = await import("@napi-rs/keyring");
  try {
    return new Entry(service, account).getPassword();
  } catch (cause) {
    // keyring-rs raises NoEntry rather than returning null on some platforms.
    if (String(cause).includes("No matching entry")) return null;
    throw new CliError("KEYCHAIN_MISSING", `keychain read failed for ${service}/${account}`, {
      cause,
    });
  }
};

export interface KeychainValue {
  /** Either raw 64-hex, or `ENC:` + hex(iv12 ‖ ct ‖ tag16). */
  line0: string;
  /** Compressed secp256k1 public key hex. Optional — wallet-cli derives it when absent. */
  line1: string | undefined;
}

/** wallet-cli's own reader (`XSH`) is `value.trim().split(/\r?\n/)` — A §3.2. */
export function parseKeychainValue(raw: string): KeychainValue {
  const lines = raw.trim().split(/\r?\n/);
  const line0 = lines[0]?.trim() ?? "";
  if (!line0) throw new CliError("KEYCHAIN_MALFORMED", "keychain entry is empty");
  const line1 = lines[1]?.trim();
  return { line0, line1: line1 ? line1 : undefined };
}

export function isWrapped(line0: string): boolean {
  return line0.startsWith(ENC_PREFIX);
}

export function derivePasswordKey(walletPass: string, saltHex: string): Buffer {
  if (!/^[0-9a-f]{32}$/.test(saltHex)) {
    throw new CliError("SESSION_MALFORMED", "passwordSalt must be 32 lowercase hex characters");
  }
  return pbkdf2Sync(
    Buffer.from(walletPass, "utf8"),
    Buffer.from(saltHex, "hex"),
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_BYTES,
    "sha256",
  );
}

/** `ENC:` unwrap, A §3.3. Returns the private key hex; never logs it. */
export function unwrapEncLine(line0: string, walletPass: string, saltHex: string): string {
  const blob = Buffer.from(line0.slice(ENC_PREFIX.length), "hex");
  if (blob.length <= IV_BYTES + TAG_BYTES) {
    throw new CliError("KEYCHAIN_MALFORMED", "ENC: payload is too short to be iv‖ct‖tag");
  }
  const key = derivePasswordKey(walletPass, saltHex);
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, IV_BYTES));
  decipher.setAuthTag(blob.subarray(blob.length - TAG_BYTES));
  let plain: Buffer;
  try {
    plain = Buffer.concat([
      decipher.update(blob.subarray(IV_BYTES, blob.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch (cause) {
    throw new CliError(
      "KEYCHAIN_MALFORMED",
      "ENC: payload failed authentication — wrong WALLET_PASS or wrong passwordSalt",
      { cause },
    );
  }
  const hex = plain.toString("utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new CliError("KEYCHAIN_MALFORMED", "unwrapped value is not a 32-byte private key");
  }
  return hex;
}

/** The inverse, for `export-member --wrap`. A fresh salt per A §3.6. */
export function wrapEncLine(
  privHex: string,
  walletPass: string,
  saltHex: string = randomBytes(PASSWORD_SALT_BYTES).toString("hex"),
): { line0: string; passwordSalt: string } {
  const key = derivePasswordKey(walletPass, saltHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(privHex, "utf8"), cipher.final()]);
  const blob = Buffer.concat([iv, ct, cipher.getAuthTag()]);
  return { line0: `${ENC_PREFIX}${blob.toString("hex")}`, passwordSalt: saltHex };
}

export interface ResolvePrivateKeyArgs {
  value: KeychainValue;
  walletPass: string | undefined;
  passwordSalt: string | undefined;
}

/** Turns the stored value into a plain private key hex, unwrapping only when it has to. */
export function resolvePrivateKey(a: ResolvePrivateKeyArgs): string {
  if (!isWrapped(a.value.line0)) {
    if (!/^[0-9a-f]{64}$/.test(a.value.line0)) {
      throw new CliError("KEYCHAIN_MALFORMED", "keychain line 0 is neither ENC: nor 64-hex");
    }
    return a.value.line0;
  }
  if (!a.walletPass) {
    throw new CliError(
      "WALLET_PASS_MISSING",
      "the keychain entry is ENC:-wrapped — set WALLET_PASS in the environment",
    );
  }
  if (!a.passwordSalt) {
    throw new CliError(
      "SESSION_MALFORMED",
      "the keychain entry is ENC:-wrapped but session.yaml carries no passwordSalt",
    );
  }
  return unwrapEncLine(a.value.line0, a.walletPass, a.passwordSalt);
}
