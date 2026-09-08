import { toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import {
  encodeCommitPolicy,
  encodeRegister,
  encodeUnrevoke,
  REGISTRY_ABI,
  toBytes32,
} from "../src/registry/calldata.js";
import { TEST_PROJECT_ID } from "./helpers.js";

const POLICY_HASH = "b".repeat(64);

/**
 * The Ledger blind-signs this calldata, so the four selector bytes are pinned as literals here
 * and cross-checked against viem. A signature change in `KlaxonRegistry` has to break this test.
 */
const SELECTORS = {
  register: "0xe1fa8e84",
  commitPolicy: "0x8ffae92b",
  unrevoke: "0x0f33125d",
} as const;

describe("KlaxonRegistry selectors", () => {
  it("match the ABI viem derives them from", () => {
    expect(toFunctionSelector("function register(bytes32)")).toBe(SELECTORS.register);
    expect(toFunctionSelector("function commitPolicy(bytes32,bytes32)")).toBe(
      SELECTORS.commitPolicy,
    );
    expect(toFunctionSelector("function unrevoke(bytes32,uint64)")).toBe(SELECTORS.unrevoke);
  });

  it("the local ABI declares exactly those three signatures", () => {
    expect(REGISTRY_ABI.map((f) => f.name)).toEqual(["register", "commitPolicy", "unrevoke"]);
    expect(REGISTRY_ABI.map((f) => f.inputs.map((i) => i.type).join(","))).toEqual([
      "bytes32",
      "bytes32,bytes32",
      "bytes32,uint64",
    ]);
  });
});

describe("calldata encoding", () => {
  it("register is the selector plus one word", () => {
    const data = encodeRegister(TEST_PROJECT_ID);
    expect(data.slice(0, 10)).toBe(SELECTORS.register);
    expect(data).toBe(`${SELECTORS.register}${TEST_PROJECT_ID}`);
    expect(data).toHaveLength(2 + 8 + 64);
  });

  it("commitPolicy carries project_id then the policy hash", () => {
    const data = encodeCommitPolicy(TEST_PROJECT_ID, POLICY_HASH);
    expect(data).toBe(`${SELECTORS.commitPolicy}${TEST_PROJECT_ID}${POLICY_HASH}`);
  });

  it("unrevoke left-pads the epoch into a uint64 word", () => {
    const data = encodeUnrevoke(TEST_PROJECT_ID, 7n);
    expect(data).toBe(`${SELECTORS.unrevoke}${TEST_PROJECT_ID}${"0".repeat(63)}7`);
  });

  it("accepts 0x-prefixed and bare hex identically", () => {
    expect(encodeRegister(`0x${TEST_PROJECT_ID}`)).toBe(encodeRegister(TEST_PROJECT_ID));
  });

  it("refuses anything that is not 32 bytes", () => {
    expect(() => toBytes32("abcd", "project_id")).toThrowError(CliError);
    expect(() => encodeCommitPolicy(TEST_PROJECT_ID, "zz".repeat(32))).toThrowError(/32 bytes/);
  });

  it("refuses a non-increasing epoch before the device ever sees it", () => {
    expect(() => encodeUnrevoke(TEST_PROJECT_ID, 0n)).toThrowError(/increasing/);
  });
});
