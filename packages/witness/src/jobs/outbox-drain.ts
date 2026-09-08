import type { WitnessContext } from "../context.js";
import { publishOutboxRow } from "../hcs/publish.js";

/**
 * D23 — picks up whatever a crash or an HCS outage left `pending`. Without it, a witness that dies
 * between "decided to release" and "published" leaves a settled payment with no message, and
 * `verify` correctly reports `WITNESS WITHHELD` against an honest witness.
 *
 * The drain never decides anything: it only finishes publishing decisions already committed.
 */
export interface DrainHandle {
  stop(): void;
  runOnce(): Promise<number>;
}

export function startOutboxDrain(ctx: WitnessContext): DrainHandle {
  let running = false;

  const runOnce = async (): Promise<number> => {
    if (running) return 0;
    running = true;
    let sent = 0;
    try {
      for (const row of ctx.repos.outbox.pending()) {
        const published = await publishOutboxRow(
          { hcs: ctx.hcs, outbox: ctx.repos.outbox, log: ctx.log },
          row,
        );
        if (!published) break; // HCS is unwell; stop and let the next tick retry in order.
        sent += 1;
        ctx.log.info(
          { outbox_id: row.id, kind: row.kind, seq: published.sequenceNumber },
          "drained outbox row",
        );
      }
    } finally {
      running = false;
    }
    return sent;
  };

  const timer = setInterval(() => {
    runOnce().catch((err) => ctx.log.error({ err }, "outbox drain failed"));
  }, ctx.config.KLAXON_OUTBOX_POLL_MS);
  timer.unref();

  return { stop: () => clearInterval(timer), runOnce };
}
