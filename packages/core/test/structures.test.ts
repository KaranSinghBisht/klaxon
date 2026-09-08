import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commitmentHash, oidcAudience } from "../src/commitment.js";
import { sealSecret } from "../src/crypto/aead.js";
import { generateDataKey, shareHash, splitKey } from "../src/crypto/datakey.js";
import { generateEphemeral } from "../src/crypto/ephemeral.js";
import { buildEncFile, parseEncFile, serializeEncFile } from "../src/encfile.js";
import { KlaxonError } from "../src/errors.js";
import { decodeMember, encodeMember } from "../src/lkrp/member.js";
import { deriveProjectId } from "../src/project.js";
import { type Commitment, CommitmentSchema, PolicySchema } from "../src/schema.js";

const PID = deriveProjectId("123456789", "root-abc");

describe("project id", () => {
  it("is deterministic and separator-sensitive", () => {
    expect(PID).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveProjectId("123456789", "root-abc")).toBe(PID);
    expect(deriveProjectId("12345678", "9root-abc")).not.toBe(PID);
  });
});

describe("commitment", () => {
  const base = (): Commitment => ({
    v: 1,
    project_id: PID,
    secret: "DEPLOYER_PRIVATE_KEY",
    gen: "3",
    repository_id: "123456789",
    run_id: "481",
    run_attempt: "1",
    environment: "production",
    ephemeral_pub: generateEphemeral().pub,
    ts: new Date().toISOString(),
  });

  it("hashes identically regardless of key order and yields the aud", () => {
    const c = base();
    const reordered = Object.fromEntries(Object.entries(c).reverse()) as Commitment;
    const h = commitmentHash(c);
    expect(commitmentHash(reordered)).toBe(h);
    expect(oidcAudience(h)).toBe(`klaxon:${h}`);
  });

  it("rejects numeric run_id and unknown fields (D17, strict)", () => {
    expect(CommitmentSchema.safeParse({ ...base(), run_id: 481 }).success).toBe(false);
    expect(CommitmentSchema.safeParse({ ...base(), extra: "x" }).success).toBe(false);
    expect(CommitmentSchema.safeParse({ ...base(), environment: "" }).success).toBe(false);
  });
});

describe(".enc file", () => {
  it("builds, serializes, parses, and self-checks a_key_name", () => {
    const dk = generateDataKey();
    const { b } = splitKey(dk);
    const file = buildEncFile({
      projectId: PID,
      secret: "DEPLOYER_PRIVATE_KEY",
      gen: "3",
      ct: sealSecret(dk, Buffer.from("0xdead"), {
        project_id: PID,
        secret: "DEPLOYER_PRIVATE_KEY",
        gen: "3",
      }),
      aCt: randomBytes(60),
      bHash: shareHash(b),
    });
    const round = parseEncFile(JSON.parse(serializeEncFile(file)));
    expect(round).toEqual(file);
    expect(round.a_key_name).toBe(`klaxon/${PID}/DEPLOYER_PRIVATE_KEY/3`);
    expect(round.alg.application_id).toBe(17);
  });
  it("rejects malformed and mismatched files", () => {
    expect(() => parseEncFile({ klaxon: 2 })).toThrow(KlaxonError);
    const dk = generateDataKey();
    const file = buildEncFile({
      projectId: PID,
      secret: "X",
      gen: "1",
      ct: sealSecret(dk, Buffer.from("s"), { project_id: PID, secret: "X", gen: "1" }),
      aCt: randomBytes(40),
      bHash: "0".repeat(64),
    });
    expect(() => parseEncFile({ ...file, gen: "2" })).toThrow(/a_key_name/);
  });
});

describe("KLAXON_MEMBER", () => {
  const m = {
    v: 1 as const,
    rootId: "root",
    applicationPath: "m/0'/16'/0'",
    applicationId: 17 as const,
    privatekey: "ab".repeat(32),
    pubkey: `02${"cd".repeat(32)}`,
  };
  it("round-trips base64 and raw JSON", () => {
    const enc = encodeMember(m);
    expect(enc).not.toContain("\n");
    expect(decodeMember(enc)).toEqual(m);
    expect(decodeMember(JSON.stringify(m))).toEqual(m);
  });
  it("refuses wrong application id and garbage", () => {
    expect(() => decodeMember(JSON.stringify({ ...m, applicationId: 18 }))).toThrow(KlaxonError);
    expect(() => decodeMember("not json")).toThrow(/JSON/);
  });
});

describe("policy", () => {
  it("applies defaults", () => {
    const p = PolicySchema.parse({
      klaxon: 1,
      project_id: PID,
      repository_id: "1",
      environments: { production: { secrets: ["DEPLOYER_PRIVATE_KEY"] } },
    });
    expect(p.max_releases).toBe(50);
    expect(p.workflow_rules.forbid_install_steps).toBe(true);
  });
});
