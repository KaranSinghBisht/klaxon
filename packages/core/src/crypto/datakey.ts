import { randomBytes } from "node:crypto";
import { sha256 } from "../canonical.js";
import { KlaxonError } from "../errors.js";

export const DATA_KEY_BYTES = 32;

export function generateDataKey(): Buffer {
  return randomBytes(DATA_KEY_BYTES);
}

/**
 * 2-of-2 XOR split. A is uniform random, B = DK ⊕ A. Each share alone is uniform and carries
 * zero information about DK — the information-theoretic property the whole design rests on.
 */
export function splitKey(dk: Uint8Array): { a: Buffer; b: Buffer } {
  const a = randomBytes(dk.length);
  const b = Buffer.alloc(dk.length);
  for (let i = 0; i < dk.length; i++) b[i] = (dk[i] as number) ^ (a[i] as number);
  return { a, b };
}

/** Given one share and the data key, compute the other share (used when B is derived, D28). */
export function otherShare(dk: Uint8Array, share: Uint8Array): Buffer {
  if (dk.length !== share.length) throw new KlaxonError("SHARE_LENGTH", "share length mismatch");
  const out = Buffer.alloc(dk.length);
  for (let i = 0; i < dk.length; i++) out[i] = (dk[i] as number) ^ (share[i] as number);
  return out;
}

export function joinShares(a: Uint8Array, b: Uint8Array): Buffer {
  if (a.length !== b.length) throw new KlaxonError("SHARE_LENGTH", "share length mismatch");
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] as number) ^ (b[i] as number);
  return out;
}

/** sha256 hex of a share — what the runner checks before trusting a witness-supplied B. */
export function shareHash(share: Uint8Array): string {
  return sha256(share).toString("hex");
}
