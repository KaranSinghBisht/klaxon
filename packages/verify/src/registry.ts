import { createPublicClient, http, parseAbiItem } from "viem";
import { sepolia } from "viem/chains";
import { VerifyInfraError } from "./errors.js";
import { mapLimit } from "./limit.js";

/** Keyless and live; `rpc.sepolia.org` is dead and drpc is paid (D14). */
export const DEFAULT_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
/** Public RPCs cap `eth_getLogs` ranges; 5000 is the width the witness's own poller uses (B §4.5). */
export const LOG_BATCH_BLOCKS = 5000n;
/** Without `--from-block`, look back this far rather than rescanning Sepolia from genesis. */
export const DEFAULT_LOOKBACK_BLOCKS = 100_000n;
const BLOCK_CONCURRENCY = 4;

export const REGISTERED_EVENT = parseAbiItem("event Registered(bytes32 indexed p, address owner)");
export const POLICY_COMMITTED_EVENT = parseAbiItem(
  "event PolicyCommitted(bytes32 indexed p, bytes32 hash)",
);
export const UNREVOKED_EVENT = parseAbiItem("event Unrevoked(bytes32 indexed p, uint64 epoch)");
/** `owner(bytes32)` — current state, so it answers however far back the claim was made. */
export const OWNER_FUNCTION = parseAbiItem("function owner(bytes32) view returns (address)");
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface RegistryLog {
  eventName: "Registered" | "PolicyCommitted" | "Unrevoked";
  blockNumber: bigint;
  logIndex: number;
  transactionHash: string;
  /** `p`, the project id, as 0x-prefixed 32-byte hex. */
  projectId: string;
  /** `PolicyCommitted` only: the committed policy hash, 0x-prefixed. */
  hash?: string;
  /** `Registered` only: the Ledger address that claimed the project. */
  owner?: string;
  /** `Unrevoked` only. */
  epoch?: bigint;
}

/** The narrow slice of a chain client this verifier needs; fakes implement it in tests. */
export interface RegistryTransport {
  getBlockNumber(): Promise<bigint>;
  getLogs(range: { fromBlock: bigint; toBlock: bigint }): Promise<RegistryLog[]>;
  getBlockTimestamp(blockNumber: bigint): Promise<bigint>;
  /**
   * Optional: `owner(p)` read straight off contract state. A `Registered` log can fall outside
   * the scanned block range, so only this can answer "not registered" rather than "not seen".
   */
  readOwner?(projectId: string): Promise<string>;
}

export interface PolicyCommit {
  kind: "policy";
  projectId: string;
  hash: string;
  blockNumber: bigint;
  seconds: bigint;
}

export interface Unrevoke {
  kind: "unrevoke";
  projectId: string;
  epoch: bigint;
  blockNumber: bigint;
  seconds: bigint;
}

export interface Registration {
  kind: "registered";
  projectId: string;
  /** The operator's Ledger address — `register` is only ever called from the device (D19). */
  owner: string;
  blockNumber: bigint;
  seconds: bigint;
}

export interface RegistryTimeline {
  registrations: Registration[];
  policies: PolicyCommit[];
  unrevokes: Unrevoke[];
  fromBlock: bigint;
  toBlock: bigint;
}

function normalizeProjectId(value: string): string {
  return value.toLowerCase().replace(/^0x/, "");
}

/** viem-backed transport against a keyless public RPC (D14). */
export function viemRegistryTransport(
  address: string,
  rpcUrl: string = DEFAULT_SEPOLIA_RPC,
): RegistryTransport {
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  return {
    getBlockNumber: () => client.getBlockNumber(),
    async getLogs(range) {
      const logs = await client.getLogs({
        address: address as `0x${string}`,
        events: [REGISTERED_EVENT, POLICY_COMMITTED_EVENT, UNREVOKED_EVENT],
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        strict: true,
      });
      return logs.map((log): RegistryLog => {
        const base = {
          blockNumber: log.blockNumber ?? 0n,
          logIndex: log.logIndex ?? 0,
          transactionHash: log.transactionHash ?? "",
          projectId: String(log.args.p),
        };
        if (log.eventName === "PolicyCommitted") {
          return { ...base, eventName: "PolicyCommitted", hash: String(log.args.hash) };
        }
        if (log.eventName === "Registered") {
          return { ...base, eventName: "Registered", owner: String(log.args.owner) };
        }
        return { ...base, eventName: "Unrevoked", epoch: BigInt(log.args.epoch) };
      });
    },
    async getBlockTimestamp(blockNumber) {
      const block = await client.getBlock({ blockNumber });
      return block.timestamp;
    },
    async readOwner(projectId) {
      const value = await client.readContract({
        address: address as `0x${string}`,
        abi: [OWNER_FUNCTION],
        functionName: "owner",
        args: [`0x${normalizeProjectId(projectId)}` as `0x${string}`],
      });
      return String(value);
    },
  };
}

/**
 * Walk `KlaxonRegistry`'s events into a timeline (PROTOCOL §8). Block timestamps are what let
 * `verify` ask "which policy was in force when this payment settled" rather than "which policy
 * is in force now" — a witness that quietly re-committed a looser policy afterwards is exactly
 * what this is for.
 */
export async function readRegistryTimeline(
  transport: RegistryTransport,
  options: { fromBlock?: bigint; toBlock?: bigint } = {},
): Promise<RegistryTimeline> {
  let head: bigint;
  try {
    head = options.toBlock ?? (await transport.getBlockNumber());
  } catch (error) {
    throw new VerifyInfraError("could not read the Sepolia head block", error);
  }
  const from =
    options.fromBlock ?? (head > DEFAULT_LOOKBACK_BLOCKS ? head - DEFAULT_LOOKBACK_BLOCKS : 0n);

  const logs: RegistryLog[] = [];
  try {
    for (let start = from; start <= head; start += LOG_BATCH_BLOCKS) {
      const end = start + LOG_BATCH_BLOCKS - 1n > head ? head : start + LOG_BATCH_BLOCKS - 1n;
      logs.push(...(await transport.getLogs({ fromBlock: start, toBlock: end })));
    }
  } catch (error) {
    throw new VerifyInfraError("could not read KlaxonRegistry logs", error);
  }

  const blocks = [...new Set(logs.map((l) => l.blockNumber))];
  let times: bigint[];
  try {
    times = await mapLimit(blocks, BLOCK_CONCURRENCY, (b) => transport.getBlockTimestamp(b));
  } catch (error) {
    throw new VerifyInfraError("could not read Sepolia block timestamps", error);
  }
  const seconds = new Map<bigint, bigint>();
  blocks.forEach((block, i) => {
    seconds.set(block, times[i] ?? 0n);
  });

  const registrations: Registration[] = [];
  const policies: PolicyCommit[] = [];
  const unrevokes: Unrevoke[] = [];
  for (const log of logs) {
    const at = seconds.get(log.blockNumber) ?? 0n;
    const projectId = normalizeProjectId(log.projectId);
    if (log.eventName === "Registered") {
      registrations.push({
        kind: "registered",
        projectId,
        owner: log.owner ?? ZERO_ADDRESS,
        blockNumber: log.blockNumber,
        seconds: at,
      });
    } else if (log.eventName === "PolicyCommitted") {
      policies.push({
        kind: "policy",
        projectId,
        hash: normalizeProjectId(log.hash ?? ""),
        blockNumber: log.blockNumber,
        seconds: at,
      });
    } else {
      unrevokes.push({
        kind: "unrevoke",
        projectId,
        epoch: log.epoch ?? 0n,
        blockNumber: log.blockNumber,
        seconds: at,
      });
    }
  }
  registrations.sort((a, b) => Number(a.blockNumber - b.blockNumber));
  policies.sort((a, b) => Number(a.blockNumber - b.blockNumber));
  unrevokes.sort((a, b) => Number(a.blockNumber - b.blockNumber));
  return { registrations, policies, unrevokes, fromBlock: from, toBlock: head };
}

/** `register` is first-write-wins, so the first `Registered` in range is the claim. */
export function registrationOf(
  timeline: RegistryTimeline,
  projectId: string,
): Registration | undefined {
  const p = normalizeProjectId(projectId);
  return timeline.registrations.find((e) => e.projectId === p);
}

/** The policy hash in force for `projectId` at `seconds` — the latest commit at or before it. */
export function policyHashAt(
  timeline: RegistryTimeline,
  projectId: string,
  seconds: bigint,
): PolicyCommit | undefined {
  const p = normalizeProjectId(projectId);
  return timeline.policies.findLast((e) => e.projectId === p && e.seconds <= seconds);
}

/** The first on-chain `Unrevoked` at or after `seconds` that clears `epoch` (PROTOCOL §8). */
export function firstUnrevokeAfter(
  timeline: RegistryTimeline,
  projectId: string,
  seconds: bigint,
  epoch: bigint,
): Unrevoke | undefined {
  const p = normalizeProjectId(projectId);
  return timeline.unrevokes.find(
    (e) => e.projectId === p && e.epoch >= epoch && e.seconds >= seconds,
  );
}

export function policyVersionCount(timeline: RegistryTimeline, projectId: string): number {
  const p = normalizeProjectId(projectId);
  return new Set(timeline.policies.filter((e) => e.projectId === p).map((e) => e.hash)).size;
}
