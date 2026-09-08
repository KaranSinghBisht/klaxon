import { createHash } from "node:crypto";

/**
 * RFC 8785 (JCS) canonical JSON — the verifier's own copy.
 *
 * `@klaxon/verify` deliberately shares no code with `@klaxon/core` (D5): if the witness and the
 * thing that audits the witness ran the same canonicalizer, a bug in it could hide a forged `h`
 * from both. This is a second implementation written from the RFC — its own key sort, its own
 * string escaper, its own surrogate check — and the test suite differentially tests it against
 * the `canonicalize` npm package over a thousand random objects.
 *
 * Commitments keep every numeric field as a JSON string (D17), so number formatting can never
 * make `h` diverge in practice; numbers are still handled here for generic JCS use, restricted
 * to values whose ECMAScript rendering is exact.
 */

export class CanonicalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizeError";
  }
}

// RFC 8785 §3.2.2.2 delegates to ECMAScript's QuoteJSONString: two-character escapes for these
// seven code points, \u00xx for the rest of C0, and the literal character for everything else.
const SHORT_ESCAPE = new Map<number, string>([
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x22, '\\"'],
  [0x5c, "\\\\"],
]);

function quoteString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    // A high surrogate must be followed by a low one and a low surrogate must not stand alone;
    // anything else is not valid Unicode and has no canonical UTF-8 form.
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) throw new CanonicalizeError("lone high surrogate");
      out += s[i] as string;
      out += s[i + 1] as string;
      i++;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) throw new CanonicalizeError("lone low surrogate");
    const short = SHORT_ESCAPE.get(unit);
    if (short !== undefined) {
      out += short;
    } else if (unit < 0x20) {
      out += `\\u${unit.toString(16).padStart(4, "0")}`;
    } else {
      out += s[i] as string;
    }
  }
  return `${out}"`;
}

function quoteNumber(n: number): string {
  if (!Number.isFinite(n)) throw new CanonicalizeError("non-finite number is not canonicalizable");
  if (!Number.isSafeInteger(n)) {
    throw new CanonicalizeError(`only safe integers may be canonicalized, got ${n}`);
  }
  return n === 0 ? "0" : String(n); // collapses -0, which JCS renders as 0
}

/** JCS orders members by the UTF-16 code units of their names, not by locale or code point. */
function byCodeUnits(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a.charCodeAt(i) as number) - (b.charCodeAt(i) as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function write(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value === true ? "true" : "false";
  if (t === "string") return quoteString(value as string);
  if (t === "number") return quoteNumber(value as number);
  if (t === "bigint") return (value as bigint).toString();
  if (t !== "object") throw new CanonicalizeError(`cannot canonicalize ${t}`);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) parts.push(item === undefined ? "null" : write(item));
    return `[${parts.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const names = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort(byCodeUnits);
  const members: string[] = [];
  for (const name of names) members.push(`${quoteString(name)}:${write(record[name])}`);
  return `{${members.join(",")}}`;
}

export function canonicalize(value: unknown): string {
  return write(value);
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** `h` = sha256(utf8(JCS(C))) — the OIDC `aud` suffix, the payment memo and what `sig` covers. */
export function commitmentHash(commitment: unknown): string {
  return sha256Hex(canonicalize(commitment));
}
