import { timingSafeEqual } from "node:crypto";
import { KlaxonError } from "./errors.js";

export const b64u = {
  encode(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
  },
  decode(s: string): Buffer {
    return Buffer.from(s, "base64url");
  },
};

export const hex = {
  encode(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("hex");
  },
  decode(s: string): Buffer {
    const clean = s.startsWith("0x") ? s.slice(2) : s;
    if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
      throw new KlaxonError("KEY_BAD_LENGTH", "invalid hex");
    }
    return Buffer.from(clean, "hex");
  },
};

export const utf8 = {
  encode(s: string): Buffer {
    return Buffer.from(s, "utf8");
  },
  decode(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("utf8");
  },
};

/** Constant-time equality; false on length mismatch without leaking which. */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function assertLength(bytes: Uint8Array, expected: number, what: string): void {
  if (bytes.length !== expected) {
    throw new KlaxonError(
      "KEY_BAD_LENGTH",
      `${what} must be ${expected} bytes, got ${bytes.length}`,
    );
  }
}
