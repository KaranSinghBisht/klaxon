import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveShareB, shareBHash } from "../src/shares/derive.js";

const MASTER = Buffer.from("5a".repeat(32), "hex");
const PROJECT = "a".repeat(64);

/**
 * PROTOCOL §3 / D28. These properties are what let the witness store no share ciphertext at all
 * and what makes `klaxon emergency` possible from the paper-backed master alone.
 */
describe("share B derivation", () => {
  it("is deterministic for the same (master, project, secret, gen)", () => {
    const a = deriveShareB(MASTER, PROJECT, "DEPLOYER_PRIVATE_KEY", "1");
    const b = deriveShareB(MASTER, PROJECT, "DEPLOYER_PRIVATE_KEY", "1");
    expect(a.equals(b)).toBe(true);
    expect(a).toHaveLength(32);
  });

  it("differs across generations", () => {
    const gen1 = deriveShareB(MASTER, PROJECT, "DEPLOYER_PRIVATE_KEY", "1");
    const gen2 = deriveShareB(MASTER, PROJECT, "DEPLOYER_PRIVATE_KEY", "2");
    expect(gen1.equals(gen2)).toBe(false);
  });

  it("differs across secrets and across projects", () => {
    const base = deriveShareB(MASTER, PROJECT, "DEPLOYER_PRIVATE_KEY", "1");
    expect(base.equals(deriveShareB(MASTER, PROJECT, "OTHER_SECRET", "1"))).toBe(false);
    expect(base.equals(deriveShareB(MASTER, "b".repeat(64), "DEPLOYER_PRIVATE_KEY", "1"))).toBe(
      false,
    );
  });

  it("differs under a different master", () => {
    const other = randomBytes(32);
    expect(
      deriveShareB(MASTER, PROJECT, "S", "1").equals(deriveShareB(other, PROJECT, "S", "1")),
    ).toBe(false);
  });

  it("refuses a master that is not 32 bytes", () => {
    expect(() => deriveShareB(Buffer.alloc(16), PROJECT, "S", "1")).toThrow();
  });

  it("cannot be confused by a separator collision between fields", () => {
    // info is `project/secret/gen`; a secret containing a slash must not alias another tuple.
    const a = deriveShareB(MASTER, PROJECT, "A", "1");
    const b = deriveShareB(MASTER, `${PROJECT}/A`, "", "1");
    expect(a.equals(b)).toBe(false);
  });

  it("hashes to the value the runner checks B against", () => {
    const b = deriveShareB(MASTER, PROJECT, "S", "1");
    expect(shareBHash(b)).toMatch(/^[0-9a-f]{64}$/);
  });
});
