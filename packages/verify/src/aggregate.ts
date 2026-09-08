import type { AttemptCheck } from "./checks.js";
import type { RevokeRecord } from "./envelope.js";
import { type Finding, finding } from "./errors.js";
import { firstUnrevokeAfter, type RegistryTimeline } from "./registry.js";
import { cmpTsString, parseTs } from "./timestamp.js";

/** One `(project, secret, gen)` budget line, as PROTOCOL §6 check 7 counts them. */
export interface MaxReleasesGroup {
  projectId: string;
  secret: string;
  gen: string;
  count: number;
  limit: number | null;
}

/**
 * 8 — releases per `(project, secret, gen)` against the policy's `max_releases` (D16: a rate
 * limit, not a single-use guarantee; check 9's unique index on `h` is what makes a commitment
 * single-use).
 */
export function checkMaxReleases(
  attempts: readonly AttemptCheck[],
  limits: ReadonlyMap<string, number>,
): { groups: MaxReleasesGroup[]; findings: Finding[] } {
  const counts = new Map<string, MaxReleasesGroup>();
  for (const a of attempts) {
    if (a.type !== "released" || a.secret === null || a.gen === null) continue;
    const key = `${a.projectId}/${a.secret}/${a.gen}`;
    const group = counts.get(key);
    if (group) group.count += 1;
    else
      counts.set(key, {
        projectId: a.projectId,
        secret: a.secret,
        gen: a.gen,
        count: 1,
        limit: limits.get(key) ?? null,
      });
  }
  const findings: Finding[] = [];
  const groups = [...counts.values()].sort((a, b) => b.count - a.count);
  for (const g of groups) {
    if (g.limit !== null && g.count > g.limit) {
      findings.push(
        finding(
          "MAX_RELEASES_EXCEEDED",
          `${g.count} releases of ${g.secret} gen ${g.gen} against a policy limit of ${g.limit}`,
        ),
      );
    }
  }
  return { groups, findings };
}

/**
 * 9 — no `released` between a `revoke` on the topic and the on-chain `Unrevoked` that clears it
 * (PROTOCOL §6 check 8, §8). The chain event is authoritative: `unrevoke` on the topic is the
 * witness talking about itself.
 */
export function checkRevocationWindows(
  attempts: readonly AttemptCheck[],
  revokes: readonly RevokeRecord[],
  timeline: RegistryTimeline | null,
): Finding[] {
  const findings: Finding[] = [];
  if (!timeline) return findings;
  for (const revoke of revokes) {
    const at = parseTs(revoke.consensusTimestamp);
    const cleared = firstUnrevokeAfter(timeline, revoke.projectId, at[0], revoke.epoch);
    for (const a of attempts) {
      if (a.type !== "released" || a.projectId !== revoke.projectId) continue;
      if (cmpTsString(a.messageConsensus, revoke.consensusTimestamp) < 0) continue;
      if (cleared && parseTs(a.messageConsensus)[0] >= cleared.seconds) continue;
      findings.push(
        finding(
          "RELEASE_WHILE_REVOKED",
          `released at ${a.messageConsensus} while the project was revoked at epoch ${revoke.epoch} since ${revoke.consensusTimestamp}${
            cleared ? ` (Unrevoked at block ${cleared.blockNumber})` : " (never unrevoked on chain)"
          }`,
          { h: a.h, pay_tx: a.payTx, at: a.messageConsensus },
        ),
      );
    }
  }
  return findings;
}
