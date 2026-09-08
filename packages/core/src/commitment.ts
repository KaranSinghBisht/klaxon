import { digestHex } from "./canonical.js";
import { type Commitment, CommitmentSchema } from "./schema.js";

/** h = sha256(canonicalize(C)) — the one value that is the OIDC aud suffix, the payment memo, the release path, and what sig_ek covers. */
export function commitmentHash(c: Commitment): string {
  return digestHex(CommitmentSchema.parse(c));
}

export function oidcAudience(hHex: string): string {
  return `klaxon:${hHex}`;
}

export const PROBE_AUDIENCE = "klaxon:probe";
