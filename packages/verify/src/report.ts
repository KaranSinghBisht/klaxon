import type { AttemptCheck, MaxReleasesGroup } from "./checks.js";
import type { Finding } from "./errors.js";
import { CLOCK_TOLERANCE_SECONDS } from "./jwks.js";
import type { Pairing } from "./pair.js";
import type { Scope } from "./scope.js";
import { tsToIso } from "./timestamp.js";

export interface ReportInputs {
  topicId: string;
  witnessAccount: string;
  registryAddress: string | null;
  mirrorUrl: string;
  rpcUrl: string | null;
  graceSeconds: number;
  priceTinybar: bigint;
  sinceTimestamp: string | null;
  generatedAt: string;
  pairs: readonly Pairing[];
  orphans: number;
  unpaidEmergencies: number;
  belowPrice: number;
  incomplete: number;
  attempts: readonly AttemptCheck[];
  maxReleases: readonly MaxReleasesGroup[];
  policyVersions: number | null;
  scope: Scope;
  findings: readonly Finding[];
}

export interface Tally {
  passed: number;
  total: number;
}

export interface VerifyReport {
  klaxon_verify: 1;
  topic: string;
  witness: string;
  registry: string | null;
  mirror: string;
  rpc: string | null;
  generated_at: string;
  since: string | null;
  grace_seconds: number;
  /** The assumed x402 price; smaller credits were not treated as payments (see `payments.ts`). */
  price_tinybar: string;
  clock_tolerance_seconds: number;
  scope: Scope;
  counts: {
    payments_found: number;
    /** Settled transfers with a commitment memo that credited less than `price_tinybar`. */
    below_price: number;
    released: number;
    refused: number;
    emergency: number;
    /** `emergency --no-pay`: nothing to pair, by design (PROTOCOL §7). */
    emergency_unpaid: number;
    withheld: number;
    pending: number;
    double_releases: number;
    incomplete_messages: number;
    orphan_messages: number;
  };
  tallies: {
    jwts_valid: Tally;
    jwts_live: number;
    jwts_via_snapshot: number;
    snapshot_timestamps: string[];
    aud_binds: Tally;
    h_recomputed: Tally;
    policy_matched: Tally;
    env_secret: Tally;
    policy_versions: number | null;
  };
  max_releases: {
    ok: boolean;
    /** `false` when no release was in scope: `ok` is then vacuous, not evidence. */
    checked: boolean;
    peak: MaxReleasesGroup | null;
  };
  /** How much of the block below is a verdict and how much is an empty denominator. */
  checks: {
    rows: number;
    not_checked: number;
  };
  attempts: AttemptCheck[];
  findings: Finding[];
  violations: number;
  unverified: number;
}

/** `null` from `pass` means the row does not apply, so the attempt leaves the denominator. */
function tally(items: readonly AttemptCheck[], pass: (a: AttemptCheck) => boolean | null): Tally {
  const applicable = items.filter((a) => pass(a) !== null);
  return { passed: applicable.filter((a) => pass(a) === true).length, total: applicable.length };
}

/** True when every *applicable* sub-check passed; null only when none of them apply. */
function and(...values: (boolean | null)[]): boolean | null {
  const applicable = values.filter((v) => v !== null);
  return applicable.length === 0 ? null : applicable.every(Boolean);
}

export function buildReport(input: ReportInputs): VerifyReport {
  const attempts = [...input.attempts];
  // `h`, `aud` and the JWT are checked over every paired attempt; the policy rows are scoped to
  // `released`, because a `refused` attempt is one the witness judged non-compliant — counting
  // its policy failure against the witness would read as a violation of the rule it enforced.
  const releasedChecks = attempts.filter((a) => a.type === "released");
  const findings = [...input.findings];
  const violations = findings.filter((f) => f.severity === "violation").length;
  const unverified = findings.length - violations;

  const snapshotTimestamps = [
    ...new Set(
      attempts
        .filter((a) => a.jwt.ok && a.jwt.source === "snapshot" && a.jwt.snapshotTimestamp)
        .map((a) => a.jwt.snapshotTimestamp as string),
    ),
  ].sort();

  const peak = input.maxReleases[0] ?? null;
  const maxOk = input.maxReleases.every((g) => g.limit === null || g.count <= g.limit);
  const maxChecked = input.maxReleases.length > 0;

  const tallies = {
    jwts_valid: tally(attempts, (a) => a.jwt.ok),
    jwts_live: attempts.filter((a) => a.jwt.ok && a.jwt.source === "live").length,
    jwts_via_snapshot: attempts.filter((a) => a.jwt.ok && a.jwt.source === "snapshot").length,
    snapshot_timestamps: snapshotTimestamps,
    aud_binds: tally(attempts, (a) => and(a.audBinds, a.claimsMatch)),
    h_recomputed: tally(attempts, (a) => and(a.hRecomputed, a.sigValid)),
    policy_matched: tally(releasedChecks, (a) => a.policy.state === "matched"),
    env_secret: tally(releasedChecks, (a) => a.envSecret.state === "ok"),
    policy_versions: input.policyVersions,
  };
  // A row with an empty denominator has not passed; it has not been asked. Counting those is
  // what stops a private repo, an all-refused topic or a missing registry printing a green block.
  const emptyTallies = [
    tallies.jwts_valid,
    tallies.aud_binds,
    tallies.h_recomputed,
    tallies.policy_matched,
    tallies.env_secret,
  ].filter((t) => t.total === 0).length;
  const doublesChecked = input.pairs.length > 0;

  return {
    klaxon_verify: 1,
    topic: input.topicId,
    witness: input.witnessAccount,
    registry: input.registryAddress,
    mirror: input.mirrorUrl,
    rpc: input.rpcUrl,
    generated_at: input.generatedAt,
    since: input.sinceTimestamp,
    grace_seconds: input.graceSeconds,
    price_tinybar: input.priceTinybar.toString(),
    clock_tolerance_seconds: CLOCK_TOLERANCE_SECONDS,
    scope: input.scope,
    counts: {
      payments_found: input.pairs.length,
      below_price: input.belowPrice,
      released: input.pairs.reduce((n, p) => n + p.released.length, 0),
      refused: input.pairs.reduce((n, p) => n + p.refused.length, 0),
      emergency: input.pairs.reduce((n, p) => n + p.emergency.length, 0),
      emergency_unpaid: input.unpaidEmergencies,
      withheld: input.pairs.filter((p) => p.withheld).length,
      pending: input.pairs.filter((p) => p.pending).length,
      double_releases: input.pairs.filter((p) => p.released.length + p.emergency.length > 1).length,
      incomplete_messages: input.incomplete,
      orphan_messages: input.orphans,
    },
    tallies,
    max_releases: { ok: maxOk, checked: maxChecked, peak },
    checks: {
      rows: 7,
      not_checked: emptyTallies + (maxChecked ? 0 : 1) + (doublesChecked ? 0 : 1),
    },
    attempts,
    findings,
    violations,
    unverified,
  };
}

const LABEL_WIDTH = 26;
const VALUE_WIDTH = 6;

function row(label: string, value: string, verdict?: string, note?: string): string {
  const line = `  ${label.padEnd(LABEL_WIDTH)}${value.padStart(VALUE_WIDTH)}`;
  const tail = [verdict, note].filter(Boolean).join("   ");
  return tail ? `${line}   ${tail}` : line;
}

function verdictOf(ok: boolean): string {
  return ok ? "OK" : "FAIL";
}

/**
 * `0/0` is not a pass. An all-refused topic, a private repo and a missing registry all empty a
 * denominator, and rendering that as `OK` is how a run that established nothing prints green.
 */
function verdictOfTally(t: Tally): string {
  if (t.total === 0) return "NOT CHECKED";
  return verdictOf(t.passed === t.total);
}

function tallyText(t: Tally): string {
  return `${t.passed}/${t.total}`;
}

/** Enough of an address to compare with the operator's Ledger without eating the line. */
function shortAddress(value: string): string {
  return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

/** `??` is this block's word for "reported, not judged" — the same weight as an `unverified`. */
function scopeRows(report: VerifyReport): string[] {
  const s = report.scope;
  const project = s.projectId ? `${s.projectId.slice(0, 12)}…` : "(none on the topic)";
  const lines: string[] = [];

  if (s.registered === true) {
    const owner = s.owner ? shortAddress(s.owner) : "(unknown)";
    lines.push(row("project registered", "", "OK", `${project} · owner ${owner} (${s.basis})`));
  } else if (s.registered === false) {
    lines.push(row("project registered", "", "FAIL", `${project} — ${s.basis}`));
  } else {
    lines.push(row("project registered", "", "??", `${project} — ${s.basis}`));
  }

  // The registry stores owner, policy hash and epoch. Neither it nor the policy anchored on it
  // names an HCS topic or a Hedera account, so both arrived from the command line unattested.
  const submitters =
    s.witnessSubmitted === null
      ? "no message on the topic named a payer"
      : s.witnessSubmitted
        ? `${report.witness} submitted messages on this topic`
        : `submitted by ${s.topicSubmitters.join(", ")}, not by ${report.witness}`;
  lines.push(row("topic + witness", "", "??", `not attested on chain — ${submitters}`));

  const extra = s.extraProjectIds.length;
  if (extra > 0) {
    lines.push(
      row("one project per topic", "", "??", `${extra} other project id${extra === 1 ? "" : "s"}`),
    );
  }
  return lines;
}

/** Which JWTs leaned on keys the witness itself published, named one by one (B §5.6). */
function snapshotBlock(report: VerifyReport): string[] {
  const used = report.attempts.filter((a) => a.jwt.ok && a.jwt.source === "snapshot");
  if (used.length === 0) return [];
  const lines = [
    "",
    `  SNAPSHOT FALLBACK ${used.length} — verified against keys the witness published, not GitHub`,
  ];
  for (const a of used) {
    const at = a.jwt.snapshotTimestamp;
    lines.push(`    h=${a.h.slice(0, 12)}…   jwks snapshot ${at ? tsToIso(at) : "(unknown)"}`);
  }
  return lines;
}

/** The block held up to camera on the second laptop (A §6.6). */
export function renderHuman(report: VerifyReport): string {
  const registry = report.registry ? `${report.registry.slice(0, 8)}…` : "(none)";
  const lines: string[] = [
    `KLAXON verify — topic ${report.topic} · witness ${report.witness} · registry ${registry}`,
    "",
  ];

  const c = report.counts;
  const t = report.tallies;
  lines.push(...scopeRows(report));
  lines.push(
    row(
      "payments found",
      String(c.payments_found),
      undefined,
      c.below_price > 0
        ? `(≥ ${report.price_tinybar} tinybar assumed · ${c.below_price} smaller credit${c.below_price === 1 ? "" : "s"} ignored)`
        : `(≥ ${report.price_tinybar} tinybar assumed)`,
    ),
  );
  lines.push(row("released", String(c.released)));
  lines.push(row("refused", String(c.refused)));
  lines.push(row("emergency", String(c.emergency)));
  if (c.emergency_unpaid > 0) {
    lines.push(
      row("emergency --no-pay", String(c.emergency_unpaid), "n/a", "no payment by design"),
    );
  }
  lines.push(
    row(
      "withheld",
      String(c.withheld),
      // Says only what pairing establishes: every settled payment drew an answer on the topic
      // inside the grace window. It is silent on a secret released with no payment behind it and
      // on one released after a refusal — those are the rows and findings below (PROTOCOL §9).
      c.withheld > 0
        ? "WITNESS WITHHELD"
        : c.payments_found === 0
          ? "NOT CHECKED"
          : "every payment answered",
      c.pending > 0 ? `(${c.pending} inside the ${report.grace_seconds}s grace window)` : undefined,
    ),
  );

  const jwtNote =
    t.jwts_via_snapshot > 0
      ? `(${t.jwts_live} live JWKS · ${t.jwts_via_snapshot} via witness snapshot ${t.snapshot_timestamps
          .map(tsToIso)
          .join(", ")})`
      : `(${t.jwts_live} live JWKS)`;
  lines.push(
    row("jwts valid at consensus", tallyText(t.jwts_valid), verdictOfTally(t.jwts_valid), jwtNote),
  );
  lines.push(row("aud binds commitment", tallyText(t.aud_binds), verdictOfTally(t.aud_binds)));
  lines.push(row("h recomputed from C", tallyText(t.h_recomputed), verdictOfTally(t.h_recomputed)));
  lines.push(
    row(
      "policy hash matched",
      tallyText(t.policy_matched),
      verdictOfTally(t.policy_matched),
      t.policy_versions !== null
        ? `(${t.policy_versions} policy version${t.policy_versions === 1 ? "" : "s"} on Sepolia)`
        : undefined,
    ),
  );
  lines.push(row("env + secret in policy", tallyText(t.env_secret), verdictOfTally(t.env_secret)));

  const peak = report.max_releases.peak;
  lines.push(
    row(
      "max_releases respected",
      "",
      report.max_releases.checked ? verdictOf(report.max_releases.ok) : "NOT CHECKED",
      peak
        ? `(peak ${peak.count} of ${peak.limit ?? "?"} — ${peak.secret} gen ${peak.gen})`
        : undefined,
    ),
  );
  lines.push(
    row(
      "double releases",
      String(c.double_releases),
      // Zero of nothing is not zero: with no payment in the window there was no pair to count.
      c.payments_found === 0 ? "NOT CHECKED" : verdictOf(c.double_releases === 0),
    ),
  );
  if (c.incomplete_messages > 0) {
    lines.push(row("incomplete messages", String(c.incomplete_messages), "??"));
  }
  if (c.orphan_messages > 0) {
    lines.push(row("unpaired messages", String(c.orphan_messages), "??"));
  }

  lines.push("");
  lines.push(`  VIOLATIONS ${report.violations}`);
  if (report.unverified > 0) lines.push(`  UNVERIFIED ${report.unverified}`);
  if (report.checks.not_checked > 0) {
    const all = report.checks.not_checked === report.checks.rows;
    lines.push(
      `  NOT CHECKED ${report.checks.not_checked} of ${report.checks.rows} rows${all ? " — this run established nothing" : ""}`,
    );
  }
  lines.push(...snapshotBlock(report));

  if (report.findings.length > 0) {
    lines.push("");
    for (const f of report.findings) {
      const tag = f.severity === "violation" ? "VIOLATION" : "unverified";
      const anchor = f.h ? ` h=${f.h.slice(0, 12)}…` : "";
      lines.push(`  ${tag} ${f.code}${anchor}`);
      lines.push(`    ${f.detail}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** 0 clean · 1 violations found · 2 the read itself could not complete (A §6.6). */
export function exitCodeFor(report: VerifyReport): 0 | 1 {
  return report.violations > 0 ? 1 : 0;
}
