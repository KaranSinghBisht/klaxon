import type { WitnessContext } from "../context.js";
import { jwksEnvelope } from "../hcs/envelope.js";
import { publishOutboxId } from "../hcs/publish.js";

/**
 * B §5.6 — GitHub rotates its OIDC signing keys, so a token from last week may reference a `kid`
 * that is gone from the live JWKS. Publishing the raw keyset daily gives `verify` something to
 * fall back to when it re-validates an old token at its payment's consensus time.
 *
 * The trust boundary is stated plainly in the docs: a snapshot is witness-authored, so an old
 * token is only as trustworthy as the witness was on the day it published — before it knew which
 * tokens it would later want to forge. Bounded, and better said than hand-waved.
 */
export interface SnapshotHandle {
  stop(): void;
  runOnce(): Promise<boolean>;
}

export function startJwksSnapshot(ctx: WitnessContext): SnapshotHandle {
  const runOnce = async (): Promise<boolean> => {
    const jwks = await ctx.oidc.fetchJwks();
    const at = ctx.clock().toISOString();
    const inserted = ctx.repos.jwks.insertIfNew(jwks, at);
    if (!inserted) return false; // Unchanged keyset: nothing new to say, nothing to publish.

    for (const project of ctx.repos.projects.list()) {
      const outboxId = ctx.repos.outbox.enqueue(
        project.topic_id,
        "jwks",
        jwksEnvelope({ ts: at, projectId: project.project_id, keys: jwks.keys }),
        at,
      );
      const published = await publishOutboxId(
        { hcs: ctx.hcs, outbox: ctx.repos.outbox, log: ctx.log },
        outboxId,
      );
      if (published) {
        ctx.repos.jwks.setConsensus(
          inserted.id,
          published.sequenceNumber,
          published.consensusTimestamp,
        );
      }
    }
    return true;
  };

  const timer = setInterval(() => {
    runOnce().catch((err) => ctx.log.error({ err }, "jwks snapshot failed"));
  }, ctx.config.KLAXON_JWKS_SNAPSHOT_MS);
  timer.unref();

  return { stop: () => clearInterval(timer), runOnce };
}
