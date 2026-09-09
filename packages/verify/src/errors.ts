/**
 * Findings and errors for the independent verifier.
 *
 * A `violation` means the witness broke the protocol and the run exits 1. An `unverified`
 * finding means this verifier could not reach a verdict (private repo, missing JWKS snapshot,
 * a chunk group the mirror node has not finished ingesting) — reported loudly, never counted
 * as proof of misbehaviour and never silently dropped.
 */
export type FindingCode =
  // pairing (PROTOCOL §9)
  | "WITNESS_WITHHELD"
  | "DOUBLE_RELEASE"
  | "ORDERING"
  | "MESSAGE_INCOMPLETE"
  | "MESSAGE_MALFORMED"
  | "RELEASE_WITHOUT_PAYMENT"
  // re-derived checks (PROTOCOL §6)
  | "COMMITMENT_MALFORMED"
  | "H_MISMATCH"
  | "SIG_INVALID"
  | "AUD_MISMATCH"
  | "CLAIM_MISMATCH"
  | "JWT_INVALID"
  | "JWKS_UNAVAILABLE"
  | "POLICY_MISMATCH"
  | "POLICY_UNVERIFIABLE"
  | "ENV_NOT_IN_POLICY"
  | "SECRET_NOT_IN_POLICY"
  | "MAX_RELEASES_EXCEEDED"
  | "RELEASE_WHILE_REVOKED"
  | "REGISTRY_UNAVAILABLE"
  // the audited scope itself (PROTOCOL §8)
  | "PROJECT_NOT_REGISTERED";

export type Severity = "violation" | "unverified";

export interface Finding {
  code: FindingCode;
  severity: Severity;
  detail: string;
  /** Commitment hash, when the finding belongs to one release attempt. */
  h?: string;
  /** Dashed Hedera transaction id of the payment, when the finding belongs to one payment. */
  pay_tx?: string;
  /** Consensus timestamp (`seconds.nanos`) the finding is anchored at. */
  at?: string;
}

const UNVERIFIED: ReadonlySet<FindingCode> = new Set<FindingCode>([
  "MESSAGE_INCOMPLETE",
  "JWKS_UNAVAILABLE",
  "POLICY_UNVERIFIABLE",
  "REGISTRY_UNAVAILABLE",
]);

export function severityOf(code: FindingCode): Severity {
  return UNVERIFIED.has(code) ? "unverified" : "violation";
}

export function finding(code: FindingCode, detail: string, at?: Partial<Finding>): Finding {
  return { code, severity: severityOf(code), detail, ...at };
}

/** A failure that stopped the read itself. The CLI turns this into exit code 2. */
export class VerifyInfraError extends Error {
  constructor(
    message: string,
    readonly cause_?: unknown,
  ) {
    super(message);
    this.name = "VerifyInfraError";
  }
}

/** A malformed input this verifier refuses to interpret (bad CLI flag, unusable fixture). */
export class VerifyUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyUsageError";
  }
}
