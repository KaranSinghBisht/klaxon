import { hkdfSync } from "node:crypto";
import { digestHex, utf8 } from "@klaxon/core";
import { CliError } from "./errors.js";

/** PROTOCOL §3 / D28. The witness stores no B; this is the same derivation, from the paper master. */
export const SHARE_B_SALT = "klaxon/b/v1";
export const SHARE_B_BYTES = 32;

export function shareBInfo(projectId: string, secret: string, gen: string): string {
  return `${projectId}/${secret}/${gen}`;
}

export function parseWitnessMaster(hex: string): Buffer {
  const clean = hex.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new CliError("MASTER_MISSING", "WITNESS_MASTER must be 32 bytes of hex");
  }
  return Buffer.from(clean, "hex");
}

/**
 * `B = HKDF-SHA256(ikm = WITNESS_MASTER, salt = "klaxon/b/v1", info = project/secret/gen, 32)`.
 * Deterministic, so `emergency` recovers every share from a piece of paper and the repo, with
 * zero witness state — the whole reason B is derived rather than stored.
 */
export function deriveShareB(
  master: Uint8Array,
  projectId: string,
  secret: string,
  gen: string,
): Buffer {
  if (master.length !== 32) throw new CliError("MASTER_MISSING", "WITNESS_MASTER must be 32 bytes");
  return Buffer.from(
    hkdfSync(
      "sha256",
      master,
      utf8.encode(SHARE_B_SALT),
      utf8.encode(shareBInfo(projectId, secret, gen)),
      SHARE_B_BYTES,
    ),
  );
}

export interface EmergencyCommitment {
  v: 1;
  type: "emergency";
  project_id: string;
  secret: string;
  gen: string;
  ts: string;
}

/**
 * PROTOCOL §7 defines an `emergency` HCS message but no commitment for it, and §1's `h` is a
 * release commitment that needs GitHub claims this path does not have. So `emergency` commits to
 * its own canonical object and uses that hash as the Hedera memo: a break-glass recovery still
 * leaves a timestamped, public trace with the same shape as a paid release.
 */
export function emergencyCommitment(
  a: Omit<EmergencyCommitment, "v" | "type">,
): EmergencyCommitment {
  return { v: 1, type: "emergency", ...a };
}

export function emergencyMemo(c: EmergencyCommitment): string {
  return digestHex(c);
}
