import { describe, expect, it } from "vitest";
import canonicalizeNpm from "canonicalize";
import { canonicalize, digestHex } from "../src/canonical.js";
import { KlaxonError } from "../src/errors.js";

describe("canonicalize (RFC 8785)", () => {
  it("sorts keys and nests", () => {
    expect(canonicalize({ b: 1, a: { d: true, c: null } })).toBe('{"a":{"c":null,"d":true},"b":1}');
  });

  it("keeps array order and maps undefined to null inside arrays", () => {
    expect(canonicalize([3, "x", undefined, [1]])).toBe('[3,"x",null,[1]]');
  });

  it("drops undefined object members", () => {
    expect(canonicalize({ a: undefined, b: "z" })).toBe('{"b":"z"}');
  });

  it("escapes strings per JSON.stringify", () => {
    expect(canonicalize({ s: 'a"b\\c\n ' })).toBe(canonicalizeNpm({ s: 'a"b\\c\n ' }));
  });

  it("orders keys by UTF-16 code units, not locale", () => {
    const obj = { ä: 1, Z: 2, a: 3, "\u{1F600}": 4, "ﬁ": 5 };
    expect(canonicalize(obj)).toBe(canonicalizeNpm(obj));
  });

  it("throws on non-finite and non-integer numbers", () => {
    expect(() => canonicalize({ x: Number.NaN })).toThrow(KlaxonError);
    expect(() => canonicalize({ x: 1.5 })).toThrow(/safe integers/);
    expect(() => canonicalize({ x: 2 ** 53 })).toThrow(/safe integers/);
  });

  it("normalizes -0 to 0", () => {
    expect(canonicalize(-0)).toBe("0");
  });

  it("differential: 1000 random commitment-shaped objects agree with the npm oracle", () => {
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0xffffffff;
    };
    // Iterate code points, not UTF-16 units, so the generator never emits a lone surrogate.
    const alphabet = Array.from("abcXYZ_-.0123456789 \"\\é中\u{1F600}");
    const str = () =>
      Array.from({ length: Math.floor(rnd() * 12) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
    const value = (depth: number): unknown => {
      const r = rnd();
      if (depth > 3 || r < 0.35) return str();
      if (r < 0.45) return Math.floor(rnd() * 1e9) * (rnd() < 0.5 ? -1 : 1);
      if (r < 0.55) return rnd() < 0.5;
      if (r < 0.6) return null;
      if (r < 0.75) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(depth + 1));
      const o: Record<string, unknown> = {};
      for (let i = 0, n = Math.floor(rnd() * 6); i < n; i++) o[str() || `k${i}`] = value(depth + 1);
      return o;
    };
    for (let i = 0; i < 1000; i++) {
      const v = value(0);
      expect(canonicalize(v)).toBe(canonicalizeNpm(v));
    }
  });

  it("rejects lone surrogates exactly like the oracle", () => {
    expect(() => canonicalize({ s: "\ud83d" })).toThrow(KlaxonError);
    expect(() => canonicalizeNpm({ s: "\ud83d" })).toThrow();
    expect(canonicalize({ s: "\u{1F600}" })).toBe(canonicalizeNpm({ s: "\u{1F600}" }));
  });

  it("digestHex is stable across key order", () => {
    expect(digestHex({ a: "1", b: "2" })).toBe(digestHex({ b: "2", a: "1" }));
    expect(digestHex({ a: "1" })).toMatch(/^[0-9a-f]{64}$/);
  });
});
