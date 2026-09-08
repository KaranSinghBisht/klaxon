import { type JWTVerifyGetKey, errors as joseErrors } from "jose";
import { verify } from "../../../verify/src/index.js";
import type { JwksOptions } from "../../../verify/src/jwks.js";
import type { FetchLike } from "../../../verify/src/mirror/client.js";
import type { RawTransaction } from "../../../verify/src/mirror/payments.js";
import type { RawTopicMessage } from "../../../verify/src/mirror/topic.js";
import type { RegistryLog, RegistryTransport } from "../../../verify/src/registry.js";
import type { VerifyReport } from "../../../verify/src/report.js";
import { REPOSITORY } from "../helpers/fixtures.js";
import type { Harness } from "../helpers/harness.js";
import { PROJECT_ID } from "../helpers/harness.js";

/**
 * Point `verify` at the witness's own run. Everything it reads is public — the mirror node, raw
 * GitHub, Sepolia — so a fake that serves the recorded shapes is a faithful stand-in, and the two
 * implementations still share no code.
 */

export const MIRROR_URL = "https://mirror.differential.test";
const REGISTRY_HEAD = 9_000_000n;
const POLICY_BLOCK = REGISTRY_HEAD - 10n;
/** How far before the first payment the operator's Ledger committed the policy on Sepolia. */
const POLICY_LEAD_SECONDS = 3_600n;

export interface UnrevokeLog {
  epoch: bigint;
  seconds: bigint;
}

export interface RegistryOptions {
  policyHash: string;
  policySeconds: bigint;
  unrevokes?: readonly UnrevokeLog[];
}

/** A `RegistryTransport` over canned `KlaxonRegistry` logs — PROTOCOL §8 with no chain. */
export function fakeRegistry(options: RegistryOptions): RegistryTransport {
  const times = new Map<bigint, bigint>([[POLICY_BLOCK, options.policySeconds]]);
  const logs: RegistryLog[] = [
    {
      eventName: "PolicyCommitted",
      blockNumber: POLICY_BLOCK,
      logIndex: 0,
      transactionHash: "0xpolicy",
      projectId: `0x${PROJECT_ID}`,
      hash: `0x${options.policyHash}`,
    },
  ];
  (options.unrevokes ?? []).forEach((u, i) => {
    const block = POLICY_BLOCK + BigInt(i + 1);
    times.set(block, u.seconds);
    logs.push({
      eventName: "Unrevoked",
      blockNumber: block,
      logIndex: 0,
      transactionHash: `0xunrevoke${i}`,
      projectId: `0x${PROJECT_ID}`,
      epoch: u.epoch,
    });
  });
  return {
    getBlockNumber: async () => REGISTRY_HEAD,
    getLogs: async ({ fromBlock, toBlock }) =>
      logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
    getBlockTimestamp: async (block) => times.get(block) ?? 0n,
  };
}

export interface NetworkOptions {
  messages: readonly RawTopicMessage[];
  transactions: readonly RawTransaction[];
  /** The exact committed bytes of `klaxon.policy.json`; hashed by `verify` as bytes (D36). */
  policyBytes: Buffer;
  /** Split the topic read over two pages so `links.next` is exercised too. */
  paginate?: boolean;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function topicPage(options: NetworkOptions, url: URL): Response {
  if (!options.paginate || options.messages.length < 2) {
    return jsonResponse({ messages: options.messages, links: { next: null } });
  }
  const half = Math.ceil(options.messages.length / 2);
  if (url.searchParams.get("cursor") === null) {
    const next = `${url.pathname}${url.search}&cursor=1`;
    return jsonResponse({ messages: options.messages.slice(0, half), links: { next } });
  }
  return jsonResponse({ messages: options.messages.slice(half), links: { next: null } });
}

/** One `fetch` standing in for the mirror node and `raw.githubusercontent.com`. */
export function fakeNetwork(options: NetworkOptions): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(input);
    calls.push(`${url.hostname}${url.pathname}${url.search}`);
    if (url.hostname === "raw.githubusercontent.com") {
      const expected = `/${REPOSITORY}/`;
      if (!url.pathname.startsWith(expected) || !url.pathname.endsWith("/klaxon.policy.json")) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(new Uint8Array(options.policyBytes), { status: 200 });
    }
    if (url.pathname.includes("/messages")) return topicPage(options, url);
    if (url.pathname.endsWith("/transactions")) {
      return jsonResponse({ transactions: options.transactions, links: { next: null } });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetch, calls };
}

/** GitHub after a key rotation: the `kid` the token names is simply gone from the live JWKS. */
export const rotatedAwayJwks: JWTVerifyGetKey = () => {
  throw new joseErrors.JWKSNoMatchingKey();
};

export interface AuditInput {
  harness: Harness;
  messages: readonly RawTopicMessage[];
  transactions: readonly RawTransaction[];
  /** Wall clock for the grace window and the report header. */
  now: Date;
  graceSeconds?: number;
  /** Defaults to the harness's own fake OIDC issuer, the key the witness verified against. */
  jwks?: JwksOptions;
  unrevokes?: readonly UnrevokeLog[];
  paginate?: boolean;
}

function earliestPaymentSeconds(transactions: readonly RawTransaction[]): bigint {
  const values = transactions.map((t) => BigInt(t.consensus_timestamp.split(".")[0] ?? "0"));
  return values.length === 0
    ? POLICY_LEAD_SECONDS
    : (values.sort((a, b) => Number(a - b))[0] ?? 0n);
}

/** Run the real `verify` over rendered mirror data, with no network and no witness code. */
export async function audit(input: AuditInput): Promise<VerifyReport> {
  const net = fakeNetwork({
    messages: input.messages,
    transactions: input.transactions,
    policyBytes: input.harness.policyBytes,
    ...(input.paginate === undefined ? {} : { paginate: input.paginate }),
  });
  const registry = fakeRegistry({
    policyHash: input.harness.policyHash,
    policySeconds: earliestPaymentSeconds(input.transactions) - POLICY_LEAD_SECONDS,
    ...(input.unrevokes === undefined ? {} : { unrevokes: input.unrevokes }),
  });
  return verify(
    {
      topicId: input.harness.ctx.repos.projects.get(PROJECT_ID)?.topic_id ?? "0.0.0",
      witnessAccount: input.harness.config.witnessAccount,
      registryAddress: input.harness.config.KLAXON_REGISTRY,
      mirrorUrl: MIRROR_URL,
      fromBlock: POLICY_BLOCK,
      now: input.now,
      ...(input.graceSeconds === undefined ? {} : { graceSeconds: input.graceSeconds }),
    },
    {
      fetch: net.fetch,
      registry,
      jwks: input.jwks ?? { remote: input.harness.issuer.keys },
    },
  );
}
