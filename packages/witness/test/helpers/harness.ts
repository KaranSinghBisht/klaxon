import {
  type Commitment,
  CommitmentSchema,
  commitmentHash,
  deriveProjectId,
  type EphemeralKeyPair,
  eciesOpen,
  generateEphemeral,
  memberPublicKeyHex,
  oidcAudience,
  signCommitment,
  signMemberRequest,
} from "@klaxon/core";
import type { FastifyInstance } from "fastify";
import type { WitnessContext } from "../../src/context.js";
import { createRepos, type Db, openDb, type Repos } from "../../src/db/index.js";
import { loadEnv, type WitnessConfig } from "../../src/env.js";
import { silentLogger } from "../../src/log.js";
import { buildServer } from "../../src/server.js";
import { deriveShareB, shareBHash } from "../../src/shares/derive.js";
import { FakeAlarmPort } from "../fakes/alarm.js";
import { FakeHcsPort } from "../fakes/hcs.js";
import { FakePaymentPort } from "../fakes/payment.js";
import { FakeRegistryPort } from "../fakes/registry.js";
import { FakeSourcePort } from "../fakes/source.js";
import {
  CLEAN_WORKFLOW,
  COMMIT_SHA,
  ENVIRONMENT,
  policyFixture,
  REPOSITORY,
  REPOSITORY_ID,
  SECRET,
  TOPIC_ID,
  TRUSTCHAIN_ROOT,
  WORKFLOW_PATH,
} from "./fixtures.js";
import { createFakeIssuer, type FakeIssuer } from "./oidc.js";

export const PROJECT_ID = deriveProjectId(REPOSITORY_ID, TRUSTCHAIN_ROOT);
export const MEMBER_PRIV = "11".repeat(32);
export const MEMBER_PUB = memberPublicKeyHex(MEMBER_PRIV);
export const WITNESS_MASTER_HEX = "5a".repeat(32);
export const NTFY_TOPIC = "klaxon-0123456789abcdef0123456789abcdef";

const BASE_ENV: NodeJS.ProcessEnv = {
  KLAXON_DB_PATH: ":memory:",
  KLAXON_PUBLIC_URL: "https://witness.test",
  WITNESS_MASTER: WITNESS_MASTER_HEX,
  HEDERA_OPERATOR_ID: "0.0.4820",
  HEDERA_OPERATOR_KEY: "0xdeadbeef",
  KLAXON_WITNESS_ACCOUNT: "0.0.4820",
  KLAXON_REGISTRY: "0x1111111111111111111111111111111111111111",
  KLAXON_MAX_RELEASES_DEFAULT: "50",
};

export interface ReleaseOptions {
  secret?: string;
  gen?: string;
  environment?: string;
  /** `null` omits the claim entirely — the A §0.5 attack. */
  environmentClaim?: string | null;
  runId?: string;
  runAttempt?: string;
  commitmentRunId?: string;
  commitmentRepositoryId?: string;
  claims?: Record<string, unknown>;
  paymentHeader?: string;
  /** Reuse a previous attempt's ephemeral key and timestamp to reproduce the exact same `h`. */
  reuse?: { C: Commitment; ek: EphemeralKeyPair };
  signWithForeignKey?: boolean;
}

export interface ReleaseResult {
  status: number;
  body: Record<string, unknown>;
  h: string;
  C: Commitment;
  ek: EphemeralKeyPair;
  payTx: string | undefined;
}

export interface Harness {
  ctx: WitnessContext;
  app: FastifyInstance;
  db: Db;
  repos: Repos;
  config: WitnessConfig;
  payment: FakePaymentPort;
  hcs: FakeHcsPort;
  source: FakeSourcePort;
  registry: FakeRegistryPort;
  alarm: FakeAlarmPort;
  issuer: FakeIssuer;
  policyHash: string;
  policyBytes: Buffer;
  setNow(date: Date): void;
  now(): Date;
  /** Serve the policy and a workflow at another commit — a sha is immutable, so a new sha is the
   *  only honest way to change what a job looks like. */
  stageCommit(sha: string, workflow: string): void;
  registerProject(overrides?: { policyHash?: string | null }): void;
  addShare(secret?: string, gen?: number): void;
  release(options?: ReleaseOptions): Promise<ReleaseResult>;
  openShareB(result: ReleaseResult): Buffer;
  memberHeaders(method: string, path: string, body: unknown): Record<string, string>;
  close(): Promise<void>;
}

/**
 * A §7.2 — the whole server over fakes and an in-memory database. Nothing here touches the
 * network, and every port the witness depends on has a fake with an explicit failure mode, so
 * "infra never revokes" can be tested rather than asserted.
 */
export async function createHarness(env: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const config = loadEnv({ ...BASE_ENV, ...env });
  const db = openDb({ path: ":memory:" });
  const repos = createRepos(db);

  let current = new Date("2026-09-10T12:00:00.000Z");
  const clock = (): Date => current;

  const payment = new FakePaymentPort(clock, config.X402_PRICE_TINYBAR);
  const hcs = new FakeHcsPort();
  const source = new FakeSourcePort();
  const registry = new FakeRegistryPort();
  const alarm = new FakeAlarmPort();
  const issuer = await createFakeIssuer();

  const ctx: WitnessContext = {
    config,
    db,
    repos,
    payment,
    hcs,
    registry,
    source,
    oidc: issuer,
    alarm,
    clock,
    log: silentLogger,
  };
  const app = buildServer(ctx);

  const policy = policyFixture({ projectId: PROJECT_ID });
  source.put(REPOSITORY, COMMIT_SHA, "klaxon.policy.json", policy.bytes);
  source.put(REPOSITORY, COMMIT_SHA, WORKFLOW_PATH, CLEAN_WORKFLOW);
  registry.setPolicyHash(PROJECT_ID, policy.hash);

  const memberHeaders = (method: string, path: string, body: unknown): Record<string, string> => {
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    return { ...signMemberRequest(MEMBER_PRIV, MEMBER_PUB, method, path, raw, current) };
  };

  const harness: Harness = {
    ctx,
    app,
    db,
    repos,
    config,
    payment,
    hcs,
    source,
    registry,
    alarm,
    issuer,
    policyHash: policy.hash,
    policyBytes: policy.bytes,
    setNow: (date) => {
      current = date;
    },
    now: clock,
    memberHeaders,

    stageCommit(sha, workflow) {
      source.put(REPOSITORY, sha, "klaxon.policy.json", policy.bytes);
      source.put(REPOSITORY, sha, WORKFLOW_PATH, workflow);
    },

    registerProject(overrides = {}) {
      repos.projects.insert({
        project_id: PROJECT_ID,
        repository: REPOSITORY,
        repository_id: REPOSITORY_ID,
        member_pubkey: MEMBER_PUB,
        topic_id: TOPIC_ID,
        ntfy_topic: NTFY_TOPIC,
        max_releases: config.KLAXON_MAX_RELEASES_DEFAULT,
        created_at: current.toISOString(),
      });
      const hash = overrides.policyHash === undefined ? policy.hash : overrides.policyHash;
      if (hash !== null) repos.projects.setPolicyAnchor(PROJECT_ID, hash, 1);
    },

    addShare(secret = SECRET, gen = 1) {
      const b = deriveShareB(config.WITNESS_MASTER, PROJECT_ID, secret, String(gen));
      repos.shares.insert({
        project_id: PROJECT_ID,
        secret,
        gen,
        b_hash: shareBHash(b),
        created_at: current.toISOString(),
      });
    },

    async release(options = {}): Promise<ReleaseResult> {
      const ek = options.reuse?.ek ?? generateEphemeral();
      const runId = options.runId ?? "4812345678";
      const runAttempt = options.runAttempt ?? "1";
      const environment = options.environment ?? ENVIRONMENT;

      const C =
        options.reuse?.C ??
        CommitmentSchema.parse({
          v: 1,
          project_id: PROJECT_ID,
          secret: options.secret ?? SECRET,
          gen: options.gen ?? "1",
          repository_id: options.commitmentRepositoryId ?? REPOSITORY_ID,
          run_id: options.commitmentRunId ?? runId,
          run_attempt: runAttempt,
          environment,
          ephemeral_pub: ek.pub,
          ts: current.toISOString(),
        } satisfies Commitment);
      const h = commitmentHash(C);

      const claims: Record<string, unknown> = {
        repository: REPOSITORY,
        repository_id: REPOSITORY_ID,
        run_id: runId,
        run_attempt: runAttempt,
        sha: COMMIT_SHA,
        workflow_ref: `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`,
        workflow_sha: COMMIT_SHA,
        job_workflow_ref: `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`,
        job_workflow_sha: COMMIT_SHA,
        event_name: "push",
        runner_environment: "github-hosted",
        jti: `jti-${h.slice(0, 12)}`,
        ...options.claims,
      };
      const envClaim =
        options.environmentClaim === undefined ? environment : options.environmentClaim;
      if (envClaim !== null) claims.environment = envClaim;

      const mint = options.signWithForeignKey ? issuer.mintWithForeignKey : issuer.mint;
      const jwt = await mint(claims, oidcAudience(h), current);
      const sig = signCommitment(ek, h);

      const response = await app.inject({
        method: "POST",
        url: `/release/${h}`,
        headers: {
          "content-type": "application/json",
          "payment-signature": options.paymentHeader ?? "valid",
        },
        payload: JSON.stringify({ C, jwt, sig }),
      });

      return {
        status: response.statusCode,
        body: response.json() as Record<string, unknown>,
        h,
        C,
        ek,
        payTx: payment.settlements.get(h)?.payTx,
      };
    },

    openShareB(result: ReleaseResult): Buffer {
      const envelope = (result.body as { share_b: Parameters<typeof eciesOpen>[2] }).share_b;
      return eciesOpen(result.ek, result.h, envelope);
    },

    async close() {
      await app.close();
      db.close();
    },
  };

  return harness;
}
