import { hkdfSync } from "node:crypto";
import { assertLength, sha256, utf8 } from "@klaxon/core";

/**
 * PROTOCOL §3 / D28 — share B is **derived, never stored**:
 *
 *   B = HKDF-SHA256(ikm = WITNESS_MASTER (32 B),
 *                   salt = utf8("klaxon/b/v1"),
 *                   info = utf8(project_id + "/" + secret + "/" + gen),
 *                   32)
 *
 * The witness keeps only `(project, secret, gen, b_hash, retired)`. That deletes the "the single
 * copy of my ciphertext lives on your VPS" objection: a witness disk is worth nothing without the
 * master, and `klaxon emergency` recomputes B from the paper-backed master with no witness state
 * at all. `info` is generation-scoped, so rotating gen produces a completely different B.
 */
export const SHARE_B_SALT = "klaxon/b/v1";
export const SHARE_B_BYTES = 32;

export function deriveShareB(
  master: Uint8Array,
  projectId: string,
  secret: string,
  gen: string,
): Buffer {
  assertLength(master, 32, "witness master");
  const info = utf8.encode(`${projectId}/${secret}/${gen}`);
  return Buffer.from(hkdfSync("sha256", master, utf8.encode(SHARE_B_SALT), info, SHARE_B_BYTES));
}

/** What `/shares` records and what the runner checks the delivered B against. */
export function shareBHash(b: Uint8Array): string {
  return sha256(b).toString("hex");
}
