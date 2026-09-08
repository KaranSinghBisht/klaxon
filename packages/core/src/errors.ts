export type KlaxonErrorCode =
  | "CANON_NON_FINITE"
  | "CANON_UNSUPPORTED"
  | "SHARE_LENGTH"
  | "AEAD_TAMPERED"
  | "ECIES_TAMPERED"
  | "ECIES_BAD_ENVELOPE"
  | "SIG_INVALID"
  | "KEY_BAD_LENGTH"
  | "ENC_MALFORMED"
  | "MEMBER_MALFORMED"
  | "MEMBER_APP_MISMATCH"
  | "LKRP_NO_DEVICE"
  | "LKRP_RESTORE_FAILED"
  | "WITNESS_BAD_SHARE";

/** All KLAXON errors carry a stable machine-readable code. Never put secret material in `message`. */
export class KlaxonError extends Error {
  readonly code: KlaxonErrorCode;
  constructor(code: KlaxonErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "KlaxonError";
    this.code = code;
  }
}
