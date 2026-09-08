import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hashPolicyBytes,
  policySkeleton,
  readPolicyFile,
  serializePolicy,
  writePolicyFile,
} from "../src/config/policy.js";
import { CliError } from "../src/errors.js";
import { TEST_PROJECT_ID, tempDir } from "./helpers.js";

const REPO_ID = "123456789";

function sha256Hex(b: Uint8Array | string): string {
  return createHash("sha256").update(b).digest("hex");
}

describe("policySkeleton", () => {
  it("produces something PolicySchema accepts, with the defaults spelled out", () => {
    const p = policySkeleton({ projectId: TEST_PROJECT_ID, repositoryId: REPO_ID });
    expect(p.klaxon).toBe(1);
    expect(p.max_releases).toBe(50);
    expect(p.workflow_rules).toEqual({ forbid_install_steps: true, require_pinned_uses: true });
    expect(Object.keys(p.environments)).toContain("production");
  });
});

describe("exact-bytes hashing", () => {
  it("hashes the committed bytes, not a re-serialization", () => {
    const dir = tempDir();
    const file = join(dir, "klaxon.policy.json");
    // Deliberately not our formatting: tabs, a different key order, no trailing newline.
    const raw = [
      "{",
      '\t"repository_id": "123456789",',
      `\t"project_id": "${TEST_PROJECT_ID}",`,
      '\t"klaxon": 1,',
      '\t"environments": { "production": { "secrets": ["DEPLOYER_PRIVATE_KEY"] } }',
      "}",
    ].join("\n");
    writeFileSync(file, raw);

    const read = readPolicyFile(file);
    expect(read.hash).toBe(sha256Hex(Buffer.from(raw, "utf8")));
    expect(read.hash).not.toBe(hashPolicyBytes(Buffer.from(serializePolicy(read.policy), "utf8")));
  });

  it("re-reading a file this CLI wrote gives the same hash it reported", () => {
    const dir = tempDir();
    const file = join(dir, "klaxon.policy.json");
    const written = writePolicyFile(
      file,
      policySkeleton({ projectId: TEST_PROJECT_ID, repositoryId: REPO_ID }),
    );
    const reread = readPolicyFile(file);
    expect(reread.hash).toBe(written.hash);
    expect(reread.hash).toBe(sha256Hex(readFileSync(file)));
  });

  it("a whitespace-only edit changes the hash — a reformat is a policy change", () => {
    const dir = tempDir();
    const file = join(dir, "klaxon.policy.json");
    const p = policySkeleton({ projectId: TEST_PROJECT_ID, repositoryId: REPO_ID });
    writeFileSync(file, serializePolicy(p));
    const before = readPolicyFile(file).hash;
    writeFileSync(file, `${JSON.stringify(p)}\n`);
    const after = readPolicyFile(file);
    expect(after.policy).toEqual(p);
    expect(after.hash).not.toBe(before);
  });

  it("is a 64-hex digest", () => {
    expect(hashPolicyBytes(Buffer.from("x"))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("readPolicyFile", () => {
  it("reports a missing file distinctly from a malformed one", () => {
    const dir = tempDir();
    expect(() => readPolicyFile(join(dir, "nope.json"))).toThrowError(CliError);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(() => readPolicyFile(bad)).toThrowError(/not valid JSON/);
    const invalid = join(dir, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ klaxon: 1 }));
    expect(() => readPolicyFile(invalid)).toThrowError(/failed validation/);
  });
});
