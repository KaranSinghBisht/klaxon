import type { AttemptCheck, MaxReleasesGroup } from "./checks.js";
import type { Finding } from "./errors.js";
import { CLOCK_TOLERANCE_SECONDS } from "./jwks.js";
import type { Pairing } from "./pair.js";
import { tsToIso } from "./timestamp.js";

export interface ReportInputs {
  topicId: string;
  witnessAccount: string;
  registryAddress: string | null;
  mirrorUrl: string;
  rpcUrl: string | null;
  graceSeconds: number;
  sinceTimestamp: string | null;
  generatedAt: string;
  pairs: readonly Pairing[];
  orphans: number;
  incomplete: number;
  attempts: readonly AttemptCheck[];
  maxReleases: readonly MaxReleasesGroup[];
  policyVersions: number | null;
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
  clock_tolerance_seconds: number;
  counts: {
    payments_found: number;
    released: number;
    refused: number;
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
    peak: MaxReleasesGroup | null;
  };
  attempts: AttemptCheck[];
  findings: Finding[];
  violations: number;
  unverified: number;
}

function tally(items: readonly AttemptCheck[], pass: (a: AttemptCheck) => boolean): Tally {
  return { passed: items.filter(pass).length, total: items.length };
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
    clock_tolerance_seconds: CLOCK_TOLERANCE_SECONDS,
    counts: {
      payments_found: input.pairs.length,
      released: input.pairs.reduce((n, p) => n + p.released.length, 0),
      refused: input.pairs.reduce((n, p) => n + p.refused.length, 0),
      withheld: input.pairs.filter((p) => p.withheld).length,
      pending: input.pairs.filter((p) => p.pending).length,
      double_releases: input.pairs.filter((p) => p.released.length > 1).length,
      incomplete_messages: input.incomplete,
      orphan_messages: input.orphans,
    },
    tallies: {
      jwts_valid: tally(attempts, (a) => a.jwt.ok),
      jwts_live: attempts.filter((a) => a.jwt.ok && a.jwt.source === "live").length,
      jwts_via_snapshot: attempts.filter((a) => a.jwt.ok && a.jwt.source === "snapshot").length,
      snapshot_timestamps: snapshotTimestamps,
      aud_binds: tally(attempts, (a) => a.audBinds && a.claimsMatch),
      h_recomputed: tally(attempts, (a) => a.hRecomputed && a.sigValid),
      policy_matched: tally(releasedChecks, (a) => a.policy.state === "matched"),
      env_secret: tally(releasedChecks, (a) => a.envSecret.state === "ok"),
      policy_versions: input.policyVersions,
    },
    max_releases: { ok: maxOk, peak },
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
  if (!verdict) return line;
  return `${line}   ${verdict}${note ? `   ${note}` : ""}`;
}

function verdictOf(ok: boolean): string {
  return ok ? "OK" : "FAIL";
}

function tallyText(t: Tally): string {
  return `${t.passed}/${t.total}`;
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
  lines.push(row("payments found", String(c.payments_found)));
  lines.push(row("released", String(c.released)));
  lines.push(row("refused", String(c.refused)));
  lines.push(
    row(
      "withheld",
      String(c.withheld),
      // The headline finding gets its own word rather than a generic FAIL (PROTOCOL §9).
      c.withheld === 0 ? "OK" : "WITNESS WITHHELD",
      c.pending > 0 ? `(${c.pending} inside the ${report.grace_seconds}s grace window)` : undefined,
    ),
  );

  const jwtNote =
    t.jwts_via_snapshot > 0
      ? `(${t.jwts_live} live JWKS · ${t.jwts_via_snapshot} via snapshot ${t.snapshot_timestamps
          .map(tsToIso)
          .join(", ")})`
      : `(${t.jwts_live} live JWKS)`;
  lines.push(
    row(
      "jwts valid at consensus",
      tallyText(t.jwts_valid),
      verdictOf(t.jwts_valid.passed === t.jwts_valid.total),
      jwtNote,
    ),
  );
  lines.push(
    row(
      "aud binds commitment",
      tallyText(t.aud_binds),
      verdictOf(t.aud_binds.passed === t.aud_binds.total),
    ),
  );
  lines.push(
    row(
      "h recomputed from C",
      tallyText(t.h_recomputed),
      verdictOf(t.h_recomputed.passed === t.h_recomputed.total),
    ),
  );
  lines.push(
    row(
      "policy hash matched",
      tallyText(t.policy_matched),
      verdictOf(t.policy_matched.passed === t.policy_matched.total),
      t.policy_versions !== null
        ? `(${t.policy_versions} policy version${t.policy_versions === 1 ? "" : "s"} on Sepolia)`
        : undefined,
    ),
  );
  lines.push(
    row(
      "env + secret in policy",
      tallyText(t.env_secret),
      verdictOf(t.env_secret.passed === t.env_secret.total),
    ),
  );

  const peak = report.max_releases.peak;
  lines.push(
    row(
      "max_releases respected",
      "",
      verdictOf(report.max_releases.ok),
      peak
        ? `(peak ${peak.count} of ${peak.limit ?? "?"} — ${peak.secret} gen ${peak.gen})`
        : undefined,
    ),
  );
  lines.push(row("double releases", String(c.double_releases), verdictOf(c.double_releases === 0)));
  if (c.incomplete_messages > 0) {
    lines.push(row("incomplete messages", String(c.incomplete_messages), "??"));
  }
  if (c.orphan_messages > 0) {
    lines.push(row("unpaired messages", String(c.orphan_messages), "??"));
  }

  lines.push("");
  lines.push(`  VIOLATIONS ${report.violations}`);
  if (report.unverified > 0) lines.push(`  UNVERIFIED ${report.unverified}`);

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
