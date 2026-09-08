export type CliErrorCode =
  | "CONFIG_MISSING"
  | "CONFIG_MALFORMED"
  | "PROJECT_UNKNOWN"
  | "KEYCHAIN_MISSING"
  | "KEYCHAIN_MALFORMED"
  | "SESSION_MISSING"
  | "SESSION_MALFORMED"
  | "WALLET_PASS_MISSING"
  | "WALLET_CLI_FAILED"
  | "WALLET_CLI_UNPARSEABLE"
  | "WITNESS_FAILED"
  | "WITNESS_MALFORMED"
  | "POLICY_MISSING"
  | "POLICY_MALFORMED"
  | "ENC_EXISTS"
  | "ENC_MISSING"
  | "NO_TRANSPORT"
  | "TTY_REFUSED"
  | "MASTER_MISSING"
  | "SHARE_MISMATCH"
  | "HEDERA_CONFIG_MISSING"
  | "BAD_ARGUMENT";

/**
 * CLI-layer failures. Distinct from `@klaxon/core`'s `KlaxonError`, whose code union is the
 * protocol's and must not grow operator-tooling concerns. Never carries secret material.
 */
export class CliError extends Error {
  readonly code: CliErrorCode;
  /** Operator-safe extra context (stderr from a subprocess, an HTTP status). Never stdout. */
  readonly detail: string | undefined;

  constructor(code: CliErrorCode, message: string, options?: { cause?: unknown; detail?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CliError";
    this.code = code;
    this.detail = options?.detail;
  }
}
