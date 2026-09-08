import { createHash } from "node:crypto";
import { KlaxonError } from "./errors.js";

/**
 * RFC 8785 (JCS) canonical JSON.
 *
 * Own implementation on purpose: `@klaxon/verify` carries an independent copy and the two are
 * differentially tested against the `canonicalize` npm package. Commitments keep every numeric
 * field as a JSON string (D17), so number formatting can never make `h` diverge; numbers are
 * still accepted here for generic use but only safe integers, and non-finite values throw.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "string":
      // RFC 8785 §3.2.2.2: a lone surrogate is not valid Unicode and cannot be canonicalized.
      if (LONE_SURROGATE.test(v))
        throw new KlaxonError("CANON_UNSUPPORTED", "lone surrogate in string");
      return JSON.stringify(v);
    case "number":
      if (!Number.isFinite(v)) throw new KlaxonError("CANON_NON_FINITE", "non-finite number");
      if (!Number.isSafeInteger(v)) {
        throw new KlaxonError("CANON_UNSUPPORTED", "only safe integers may be canonicalized");
      }
      return Object.is(v, -0) ? "0" : String(v);
    case "bigint":
      return v.toString();
    case "undefined":
    case "function":
    case "symbol":
      throw new KlaxonError("CANON_UNSUPPORTED", `cannot canonicalize ${typeof v}`);
    case "object":
      break;
  }
  if (Array.isArray(v)) {
    return `[${v.map((x) => (x === undefined ? "null" : serialize(x))).join(",")}]`;
  }
  const obj = v as Record<string, unknown>;
  // JCS: sort keys by UTF-16 code units, which is JavaScript's default string comparison.
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`).join(",")}}`;
}

export function sha256(data: Uint8Array | string): Buffer {
  return createHash("sha256").update(data).digest();
}

/** sha256(utf8(canonicalize(v))) as lowercase hex. */
export function digestHex(value: unknown): string {
  return sha256(canonicalize(value)).toString("hex");
}
