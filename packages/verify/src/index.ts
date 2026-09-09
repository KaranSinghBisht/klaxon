import { type ChecksContext, runChecks } from "./checks.js";
import { parseEnvelopes } from "./envelope.js";
import { type Finding, finding, VerifyUsageError } from "./errors.js";
import type { JwksOptions, JwksSnapshot } from "./jwks.js";
import {
  DEFAULT_MIRROR_URL,
  type FetchLike,
  MirrorClient,
  type MirrorClientOptions,
} from "./mirror/client.js";
import { DEFAULT_PRICE_TINYBAR, readPayments } from "./mirror/payments.js";
import { readTopic } from "./mirror/topic.js";
import { DEFAULT_GRACE_SECONDS, pairPayments } from "./pair.js";
import { PolicyCache } from "./policy.js";
import {
  DEFAULT_SEPOLIA_RPC,
  policyVersionCount,
  type RegistryTimeline,
  type RegistryTransport,
  readRegistryTimeline,
  viemRegistryTransport,
} from "./registry.js";
import { buildReport, type VerifyReport } from "./report.js";
import { checkScope } from "./scope.js";
import { formatTs, parseTs } from "./timestamp.js";

export interface VerifyOptions {
  topicId: string;
  witnessAccount: string;
  /** `KlaxonRegistry` on Sepolia. Without it, policy and revocation rows read `unverifiable`. */
  registryAddress?: string;
  mirrorUrl?: string;
  rpcUrl?: string;
  /** Hedera `seconds.nanos`; the first payment this run will judge. */
  sinceTimestamp?: string;
  graceSeconds?: number;
  /** Smallest credit to the witness that counts as a payment. Defaults to the advertised price. */
  priceTinybar?: bigint;
  fromBlock?: bigint;
  /** Injected in tests so the grace window and the report header are deterministic. */
  now?: Date;
}

/**
 * A payment settles, and its release reaches consensus a moment later. With one cutoff for both
 * reads, a pair straddling it loses its payment and the release is reported as one nobody paid
 * for. So the payment read starts a grace window further back than `--since`; those earlier
 * payments exist only to claim their answers and are not themselves audited (see `pair.ts`).
 */
function paymentsSince(since: string, seconds: number): string {
  const [s, n] = parseTs(since);
  const back = BigInt(Math.trunc(seconds));
  return formatTs([s > back ? s - back : 0n, n]);
}

export interface VerifyTransports {
  fetch?: FetchLike;
  mirror?: MirrorClient;
  mirrorOptions?: Partial<MirrorClientOptions>;
  registry?: RegistryTransport;
  jwks?: JwksOptions;
  verifyJwt?: ChecksContext["verifyJwt"];
}

/**
 * Re-derive the whole release history of one project from public data: Hedera for what was paid
 * and what the witness said, Sepolia for what policy was in force, GitHub for the policy bytes
 * themselves. Nothing here trusts the witness, and nothing here imports its code (D5).
 */
export async function verify(
  options: VerifyOptions,
  transports: VerifyTransports = {},
): Promise<VerifyReport> {
  if (!/^\d+\.\d+\.\d+$/.test(options.topicId)) {
    throw new VerifyUsageError(`--topic must be a Hedera id like 0.0.1234, got ${options.topicId}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(options.witnessAccount)) {
    throw new VerifyUsageError(
      `--witness must be a Hedera id like 0.0.1234, got ${options.witnessAccount}`,
    );
  }
  if (options.registryAddress && !/^0x[0-9a-fA-F]{40}$/.test(options.registryAddress)) {
    throw new VerifyUsageError(
      `--registry must be a 20-byte address, got ${options.registryAddress}`,
    );
  }

  if (options.priceTinybar !== undefined && options.priceTinybar < 0n) {
    throw new VerifyUsageError(`--price-tinybar must not be negative, got ${options.priceTinybar}`);
  }

  const mirrorUrl = options.mirrorUrl ?? DEFAULT_MIRROR_URL;
  const graceSeconds = options.graceSeconds ?? DEFAULT_GRACE_SECONDS;
  const priceTinybar = options.priceTinybar ?? DEFAULT_PRICE_TINYBAR;
  const now = options.now ?? new Date();
  const mirror =
    transports.mirror ??
    new MirrorClient({
      baseUrl: mirrorUrl,
      ...(transports.fetch ? { fetch: transports.fetch } : {}),
      ...transports.mirrorOptions,
    });

  const lookback = Math.max(graceSeconds, DEFAULT_GRACE_SECONDS);
  const paymentsFrom = options.sinceTimestamp
    ? paymentsSince(options.sinceTimestamp, lookback)
    : undefined;
  const [topic, payments] = await Promise.all([
    readTopic(mirror, options.topicId, options.sinceTimestamp),
    readPayments(mirror, options.witnessAccount, paymentsFrom, priceTinybar),
  ]);

  const findings: Finding[] = [];
  for (const group of topic.incomplete) {
    findings.push(
      finding(
        "MESSAGE_INCOMPLETE",
        `chunk group ${group.key} has ${group.have} of ${group.total} chunks on the mirror node`,
        { at: group.lastTimestamp },
      ),
    );
  }
  for (const bad of topic.malformed) {
    findings.push(
      finding("MESSAGE_MALFORMED", `message ${bad.key} is not valid JSON: ${bad.reason}`, {
        at: bad.consensusTimestamp,
      }),
    );
  }

  const parsed = parseEnvelopes(topic.messages);
  findings.push(...parsed.findings);

  const paired = pairPayments(payments.payments, parsed.attempts, {
    graceSeconds,
    now,
    ...(options.sinceTimestamp ? { auditFrom: options.sinceTimestamp } : {}),
  });
  findings.push(...paired.findings);

  let timeline: RegistryTimeline | null = null;
  let registry: RegistryTransport | null = null;
  if (options.registryAddress) {
    registry =
      transports.registry ??
      viemRegistryTransport(options.registryAddress, options.rpcUrl ?? DEFAULT_SEPOLIA_RPC);
    timeline = await readRegistryTimeline(registry, {
      ...(options.fromBlock !== undefined ? { fromBlock: options.fromBlock } : {}),
    });
  } else {
    findings.push(
      finding(
        "REGISTRY_UNAVAILABLE",
        "no --registry given: policy hashes and revocation windows were not checked against Sepolia",
      ),
    );
  }

  const snapshots: JwksSnapshot[] = parsed.jwks.map((s) => ({
    consensusSeconds: s.consensusSeconds,
    consensusTimestamp: s.consensusTimestamp,
    keys: s.keys,
  }));

  const context: ChecksContext = {
    snapshots,
    policies: new PolicyCache(transports.fetch),
    timeline,
    revokes: parsed.revokes,
    unrevokes: parsed.unrevokes,
    ...(transports.verifyJwt ? { verifyJwt: transports.verifyJwt } : {}),
    ...(transports.jwks ? { jwksOptions: transports.jwks } : {}),
  };
  const checked = await runChecks(paired.pairs, context);
  findings.push(...checked.attempts.flatMap((a) => a.findings), ...checked.findings);

  // One topic per project (PROTOCOL §7), so any envelope on it names the project the policy
  // timeline should be scoped to — not just the ones that carry a commitment.
  const projectIds = [
    ...new Set([
      ...checked.attempts.map((a) => a.projectId),
      ...paired.unpaidEmergencies.map((e) => e.projectId),
      ...parsed.revokes.map((r) => r.projectId),
      ...parsed.unrevokes.map((u) => u.projectId),
      ...parsed.jwks.map((j) => j.projectId),
      ...parsed.rotates.map((r) => r.projectId),
      ...parsed.other.map((o) => o.projectId),
    ]),
  ];
  const firstProject = projectIds[0];
  const policyVersions =
    timeline && firstProject ? policyVersionCount(timeline, firstProject) : null;

  const scoped = await checkScope({
    witnessAccount: options.witnessAccount,
    projectIds,
    topicSubmitters: topic.messages
      .map((m) => m.payerAccountId)
      .filter((p): p is string => p !== null),
    timeline,
    transport: registry,
  });
  findings.push(...scoped.findings);

  return buildReport({
    topicId: options.topicId,
    witnessAccount: options.witnessAccount,
    registryAddress: options.registryAddress ?? null,
    mirrorUrl,
    rpcUrl: options.registryAddress ? (options.rpcUrl ?? DEFAULT_SEPOLIA_RPC) : null,
    graceSeconds,
    priceTinybar,
    sinceTimestamp: options.sinceTimestamp ?? null,
    generatedAt: now.toISOString(),
    pairs: paired.pairs,
    orphans: paired.orphans.length,
    unpaidEmergencies: paired.unpaidEmergencies.length,
    belowPrice: payments.belowPrice,
    incomplete: topic.incomplete.length,
    attempts: checked.attempts,
    maxReleases: checked.maxReleases,
    policyVersions,
    scope: scoped.scope,
    findings,
  });
}

export { canonicalize, commitmentHash, sha256Hex } from "./canonical.js";
export { runChecks, verifyCommitmentSig } from "./checks.js";
export { parseEnvelopes } from "./envelope.js";
export {
  type Finding,
  type FindingCode,
  VerifyInfraError,
  VerifyUsageError,
} from "./errors.js";
export { type JwksSnapshot, verifyAtTime, verifyLive } from "./jwks.js";
export { MirrorClient } from "./mirror/client.js";
export {
  DEFAULT_PRICE_TINYBAR,
  type Payment,
  readPayments,
  selectPayments,
  toDashedTxId,
} from "./mirror/payments.js";
export { readTopic, reassemble, type TopicMessage } from "./mirror/topic.js";
export { DEFAULT_GRACE_SECONDS, pairPayments } from "./pair.js";
export { fetchPolicyAt, PolicyCache } from "./policy.js";
export { readRegistryTimeline, viemRegistryTransport } from "./registry.js";
export { buildReport, exitCodeFor, renderHuman, type VerifyReport } from "./report.js";
export { checkScope, type Scope } from "./scope.js";
