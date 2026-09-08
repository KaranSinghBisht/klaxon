/**
 * Registry of every value that must never appear in logs: member private key, wsek, domain key,
 * data key, both shares, and the plaintext. GitHub masking is literal and line-oriented, so
 * derived encodings are registered too (hex and base64url) where they are cheap to compute.
 */
const registry = new Set<string>();

export function registerSecretMaterial(...values: Array<string | Uint8Array>): void {
  for (const v of values) {
    if (typeof v === "string") {
      if (v.length > 0) registry.add(v);
      continue;
    }
    const buf = Buffer.from(v);
    if (buf.length === 0) continue;
    registry.add(buf.toString("hex"));
    registry.add(buf.toString("base64url"));
    registry.add(buf.toString("base64"));
  }
}

/** Emit `::add-mask::<value>` lines — call before anything else touches the material. */
export function emitGithubMasks(write: (line: string) => void): void {
  for (const v of registry) write(`::add-mask::${v}`);
}

/** Test hook: throws if any registered value appears verbatim in `haystack`. */
export function assertNotLeaked(haystack: string): void {
  for (const v of registry) {
    if (v.length >= 8 && haystack.includes(v)) {
      throw new Error(`secret material leaked (${v.length} chars)`);
    }
  }
}

export function clearSecretRegistry(): void {
  registry.clear();
}
