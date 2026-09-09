import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import canonicalizeOracle from "canonicalize";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
  errors as joseErrors,
  SignJWT,
} from "jose";
import type { FetchLike } from "../../src/mirror/client.js";
import type { RegistryLog, RegistryTransport } from "../../src/registry.js";

export const TOPIC_ID = "0.0.4321";
export const WITNESS = "0.0.4820";
export const REGISTRY = "0x1234567890abcdef1234567890abcdef12345678";
export const PROJECT_ID = "a".repeat(64);
export const REPOSITORY = "KaranSinghBisht/klaxon-demo";
export const REPOSITORY_ID = "987654321";
export const COMMIT_SHA = "b".repeat(40);
export const ISSUER = "https://token.actions.githubusercontent.com";

export const POLICY_BYTES = readFileSync(
  fileURLToPath(new URL("../fixtures/klaxon.policy.json", import.meta.url)),
);
export const POLICY_HASH = createHash("sha256").update(POLICY_BYTES).digest("hex");

/** The oracle, not our own canonicalizer: a fixture built with the code under test proves nothing. */
export function oracleH(commitment: unknown): string {
  const json = canonicalizeOracle(commitment);
  if (json === undefined) throw new Error("oracle refused to canonicalize the commitment");
  return createHash("sha256").update(json, "utf8").digest("hex");
}

const SPKI_PREFIX_LEN = 12;

export interface Ephemeral {
  pub: { sig: string; enc: string };
  signHash(h: string): string;
}

export function ephemeral(): Ephemeral {
  const sigPair = generateKeyPairSync("ed25519");
  const encPair = generateKeyPairSync("x25519");
  const raw = (key: ReturnType<typeof generateKeyPairSync>["publicKey"]) =>
    Buffer.from(key.export({ type: "spki", format: "der" })).subarray(SPKI_PREFIX_LEN);
  return {
    pub: {
      sig: raw(sigPair.publicKey).toString("base64url"),
      enc: raw(encPair.publicKey).toString("base64url"),
    },
    signHash(h) {
      return sign(null, Buffer.from(`klaxon-release-v1:${h}`, "utf8"), sigPair.privateKey).toString(
        "base64url",
      );
    },
  };
}

export interface CommitmentInput {
  secret?: string;
  gen?: string;
  runId?: string;
  runAttempt?: string;
  environment?: string;
  ts?: string;
}

export function buildCommitment(input: CommitmentInput = {}): {
  C: Record<string, unknown>;
  h: string;
  sig: string;
} {
  const ek = ephemeral();
  const C: Record<string, unknown> = {
    v: 1,
    project_id: PROJECT_ID,
    secret: input.secret ?? "DEPLOYER_PRIVATE_KEY",
    gen: input.gen ?? "3",
    repository_id: REPOSITORY_ID,
    run_id: input.runId ?? "17000000001",
    run_attempt: input.runAttempt ?? "1",
    environment: input.environment ?? "production",
    ephemeral_pub: ek.pub,
    ts: input.ts ?? "2026-09-10T00:05:00.000Z",
  };
  const h = oracleH(C);
  return { C, h, sig: ek.signHash(h) };
}

export interface OidcKeys {
  kid: string;
  publicJwk: JWK;
  jwks: JWTVerifyGetKey;
  mint(claims: Record<string, unknown>, atSeconds: number, ttl?: number): Promise<string>;
}

/** A throwaway RSA key pair standing in for GitHub's OIDC signer, so no test touches the network. */
export async function oidcKeys(kid: string): Promise<OidcKeys> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return {
    kid,
    publicJwk,
    jwks: createLocalJWKSet({ keys: [publicJwk] }),
    async mint(claims, atSeconds, ttl = 300) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(ISSUER)
        .setIssuedAt(atSeconds - 30)
        .setNotBefore(atSeconds - 30)
        .setExpirationTime(atSeconds + ttl)
        .sign(privateKey);
    },
  };
}

/** A key set that behaves like GitHub after a rotation: the `kid` is simply gone. */
export const rotatedAwayJwks: JWTVerifyGetKey = () => {
  throw new joseErrors.JWKSNoMatchingKey();
};

export interface JwtClaims {
  h: string;
  environment?: string | null;
  runId?: string;
  runAttempt?: string;
  repositoryId?: string;
  sha?: string;
}

export async function mintJwt(
  keys: OidcKeys,
  atSeconds: number,
  claims: JwtClaims,
  ttl?: number,
): Promise<string> {
  const payload: Record<string, unknown> = {
    aud: `klaxon:${claims.h}`,
    repository: REPOSITORY,
    repository_id: claims.repositoryId ?? REPOSITORY_ID,
    run_id: claims.runId ?? "17000000001",
    run_attempt: claims.runAttempt ?? "1",
    sha: claims.sha ?? COMMIT_SHA,
    job_workflow_ref: `${REPOSITORY}/.github/workflows/deploy.yml@refs/heads/main`,
    event_name: "push",
    runner_environment: "self-hosted",
  };
  if (claims.environment !== null) payload.environment = claims.environment ?? "production";
  return keys.mint(payload, atSeconds, ttl);
}

export interface RawMessage {
  chunk_info?: unknown;
  consensus_timestamp: string;
  message: string;
  sequence_number: number;
  topic_id: string;
  payer_account_id: string;
}

let sequence = 0;

export function topicMessage(
  body: unknown,
  consensusTimestamp: string,
  payer: string = WITNESS,
): RawMessage {
  sequence += 1;
  return {
    chunk_info: null,
    consensus_timestamp: consensusTimestamp,
    message: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
    sequence_number: sequence,
    topic_id: TOPIC_ID,
    payer_account_id: payer,
  };
}

/** The advertised price, which is what an honest runner pays (B §2.2). */
export const PRICE_TINYBAR = 100000;

export function payment(
  memo: string,
  consensusTimestamp: string,
  txId: string,
  amount: number = PRICE_TINYBAR,
): unknown {
  return {
    charged_tx_fee: 246668,
    consensus_timestamp: consensusTimestamp,
    memo_base64: Buffer.from(memo, "utf8").toString("base64"),
    name: "CRYPTOTRANSFER",
    result: "SUCCESS",
    transaction_id: txId,
    transfers: [
      { account: "0.0.802", amount: 246668, is_approval: false },
      { account: "0.0.10405046", amount: -amount, is_approval: false },
      { account: WITNESS, amount, is_approval: false },
    ],
  };
}

export interface FakeNetwork {
  fetch: FetchLike;
  calls: string[];
}

/**
 * One `fetch` standing in for the mirror node and raw.githubusercontent.com. Everything the
 * verifier reads is public, so a fake that serves recorded shapes is a faithful stand-in.
 */
export function fakeNetwork(options: {
  messages: readonly unknown[];
  transactions: readonly unknown[];
  policyBytes?: Uint8Array | null;
  policyStatus?: number;
  /** Split the topic read across two pages to exercise `links.next`. */
  paginate?: boolean;
}): FakeNetwork {
  const calls: string[] = [];
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const fetch: FetchLike = async (input) => {
    const url = new URL(input);
    calls.push(`${url.pathname}${url.search}`);
    if (url.hostname === "raw.githubusercontent.com") {
      const status = options.policyStatus ?? (options.policyBytes ? 200 : 404);
      if (status !== 200 || !options.policyBytes) return new Response("Not Found", { status });
      return new Response(Buffer.from(options.policyBytes), { status: 200 });
    }
    if (url.pathname.includes("/messages")) {
      const cursor = url.searchParams.get("cursor");
      if (!options.paginate || options.messages.length < 2) {
        return json({ messages: options.messages, links: { next: null } });
      }
      if (cursor === null) {
        return json({
          messages: options.messages.slice(0, 1),
          links: {
            next: `/api/v1/topics/${TOPIC_ID}/messages?limit=100&order=asc&cursor=1`,
          },
        });
      }
      return json({ messages: options.messages.slice(1), links: { next: null } });
    }
    if (url.pathname.endsWith("/transactions")) {
      return json({ transactions: options.transactions, links: { next: null } });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetch, calls };
}

export const OWNER_ADDRESS = "0x00000000219ab540356cbb839cbe05303d7705fa";
export const ZERO = "0x0000000000000000000000000000000000000000";

export interface FakeRegistryOptions {
  policyHash?: string;
  policyBlockSeconds?: bigint;
  unrevokes?: { epoch: bigint; seconds: bigint }[];
  head?: bigint;
  /** Emit a `Registered` log in the scanned range. */
  registered?: boolean;
  /** Answer `owner(p)` off contract state, the way a real RPC does. */
  owner?: string;
}

/** A `RegistryTransport` over canned logs — the chain read with no chain. */
export function fakeRegistry(options: FakeRegistryOptions = {}): RegistryTransport {
  const head = options.head ?? 9_000_000n;
  const policyBlock = head - 1000n;
  const seconds = new Map<bigint, bigint>();
  const logs: RegistryLog[] = [];

  if (options.registered) {
    const claimBlock = policyBlock - 1n;
    logs.push({
      eventName: "Registered",
      blockNumber: claimBlock,
      logIndex: 0,
      transactionHash: "0xc1a1m",
      projectId: `0x${PROJECT_ID}`,
      owner: OWNER_ADDRESS,
    });
    seconds.set(claimBlock, (options.policyBlockSeconds ?? 1_788_000_000n) - 1n);
  }

  logs.push({
    eventName: "PolicyCommitted",
    blockNumber: policyBlock,
    logIndex: 0,
    transactionHash: "0xdead",
    projectId: `0x${PROJECT_ID}`,
    hash: `0x${options.policyHash ?? POLICY_HASH}`,
  });
  seconds.set(policyBlock, options.policyBlockSeconds ?? 1_788_000_000n);

  options.unrevokes?.forEach((u, i) => {
    const block = policyBlock + BigInt(i + 1);
    logs.push({
      eventName: "Unrevoked",
      blockNumber: block,
      logIndex: 0,
      transactionHash: `0xbeef${i}`,
      projectId: `0x${PROJECT_ID}`,
      epoch: u.epoch,
    });
    seconds.set(block, u.seconds);
  });

  return {
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }) =>
      logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
    getBlockTimestamp: async (block) => seconds.get(block) ?? 0n,
    ...(options.owner ? { readOwner: async () => options.owner as string } : {}),
  };
}

export function released(body: {
  h: string;
  C: unknown;
  jwt: string;
  sig: string;
  payTx: string;
  ts?: string;
}): unknown {
  return {
    klaxon: 1,
    type: "released",
    ts: body.ts ?? "2026-09-10T00:05:03.000Z",
    project_id: PROJECT_ID,
    h: body.h,
    C: body.C,
    jwt: body.jwt,
    sig: body.sig,
    pay_tx: body.payTx,
  };
}

export function refused(body: {
  h: string;
  C: unknown;
  jwt: string;
  sig: string;
  payTx: string;
  check?: number;
  reason?: string;
  class?: string;
}): unknown {
  return {
    ...(released(body) as Record<string, unknown>),
    type: "refused",
    class: body.class ?? "auth",
    check: body.check ?? 3,
    reason: body.reason ?? "environment claim absent",
  };
}
