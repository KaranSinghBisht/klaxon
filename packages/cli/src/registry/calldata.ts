import { encodeFunctionData, type Hex } from "viem";
import { CliError } from "../errors.js";

/** `KlaxonRegistry` (PROTOCOL §8). Only the three the operator's Ledger ever signs. */
export const REGISTRY_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "p", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "commitPolicy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "p", type: "bytes32" },
      { name: "h", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "unrevoke",
    stateMutability: "nonpayable",
    inputs: [
      { name: "p", type: "bytes32" },
      { name: "e", type: "uint64" },
    ],
    outputs: [],
  },
] as const;

/** `project_id` and `policy_hash` travel as bare 64-hex everywhere else in KLAXON. */
export function toBytes32(value: string, what: string): Hex {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new CliError("BAD_ARGUMENT", `${what} must be 32 bytes of hex`);
  }
  return `0x${clean.toLowerCase()}` as Hex;
}

export function encodeRegister(projectId: string): Hex {
  return encodeFunctionData({
    abi: REGISTRY_ABI,
    functionName: "register",
    args: [toBytes32(projectId, "project_id")],
  });
}

export function encodeCommitPolicy(projectId: string, policyHash: string): Hex {
  return encodeFunctionData({
    abi: REGISTRY_ABI,
    functionName: "commitPolicy",
    args: [toBytes32(projectId, "project_id"), toBytes32(policyHash, "policy hash")],
  });
}

export function encodeUnrevoke(projectId: string, epoch: bigint): Hex {
  if (epoch <= 0n) throw new CliError("BAD_ARGUMENT", "epoch must be positive and increasing");
  return encodeFunctionData({
    abi: REGISTRY_ABI,
    functionName: "unrevoke",
    args: [toBytes32(projectId, "project_id"), epoch],
  });
}
