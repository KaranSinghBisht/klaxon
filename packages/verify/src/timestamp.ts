/**
 * Hedera consensus timestamps are `seconds.nanos` decimal strings. Floats lose nanosecond
 * resolution well inside the range we compare, so every comparison here goes through a
 * `[BigInt(seconds), BigInt(nanos)]` pair (B §3.4).
 */
export type Ts = readonly [bigint, bigint];

const TS_RE = /^(\d{1,19})(?:\.(\d{1,9}))?$/;

export function parseTs(value: string): Ts {
  const m = TS_RE.exec(value.trim());
  if (!m) throw new Error(`not a Hedera timestamp: ${value}`);
  const nanos = (m[2] ?? "").padEnd(9, "0");
  return [BigInt(m[1] as string), BigInt(nanos)];
}

export function tryParseTs(value: string): Ts | null {
  try {
    return parseTs(value);
  } catch {
    return null;
  }
}

export function cmpTs(a: Ts, b: Ts): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

export function cmpTsString(a: string, b: string): number {
  return cmpTs(parseTs(a), parseTs(b));
}

export function formatTs(t: Ts): string {
  return `${t[0]}.${t[1].toString().padStart(9, "0")}`;
}

/** Whole seconds, which is the resolution JWT `exp`/`nbf` are expressed in. */
export function tsSeconds(value: string): number {
  return Number(parseTs(value)[0]);
}

/** ISO-8601 rendering for the report; milliseconds are enough for a human line. */
export function tsToIso(value: string): string {
  const [s, n] = parseTs(value);
  return new Date(Number(s) * 1000 + Number(n / 1_000_000n)).toISOString();
}

export function nowTs(now: Date = new Date()): Ts {
  const ms = now.getTime();
  return [BigInt(Math.floor(ms / 1000)), BigInt((ms % 1000) * 1_000_000)];
}

/** `a` plus `seconds`, used for the withheld grace window. */
export function addSeconds(a: Ts, seconds: number): Ts {
  return [a[0] + BigInt(Math.trunc(seconds)), a[1]];
}
