import type { WitnessContext } from "../context.js";
import type { OutboxRow } from "../db/index.js";
import { publishOutboxRow } from "../hcs/publish.js";

/**
 * D23 — picks up whatever a crash or an HCS outage left `pending`. Without it, a witness that dies
 * between "decided to release" and "published" leaves a settled payment with no message, and
 * `verify` correctly reports `WITNESS WITHHELD` against an honest witness.
 *
 * The drain never decides anything: it only finishes publishing decisions already committed.
 *
 * It also never lets one row hold the queue. A message that cannot be published — a deleted topic,
 * a submit key rotated out from under the witness — is not a reason for every later `released` and
 * `refused` to miss consensus, because the audit trail is the whole claim. So a failure backs the
 * row off, the drain moves to the next one, and a row that has burned its retry budget is retired
 * to `failed` with a loud log rather than blocking behind itself forever.
 */
export interface DrainHandle {
  stop(): void;
  runOnce(): Promise<number>;
}

/**
 * How many publish attempts a row gets before it is treated as poison rather than as an outage.
 * With the backoff below that is roughly twenty minutes of trying, which is far longer than any
 * Hedera blip and far shorter than "forever".
 */
export const MAX_OUTBOX_ATTEMPTS = 12;

/** Doubling from one second: a blip costs a second, a real outage settles at the cap. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 300_000;

export function backoffMs(attempts: number): number {
  if (attempts < 1) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 30), BACKOFF_MAX_MS);
}

export function startOutboxDrain(ctx: WitnessContext): DrainHandle {
  let running = false;
  /**
   * `id` → the epoch millisecond this row may next be attempted. In memory on purpose: `attempts`
   * is durable, the schedule is not, so a restart is itself a retry — which is the right answer
   * for a witness that has just come back up.
   */
  const nextAttemptAt = new Map<number, number>();

  const runOnce = async (): Promise<number> => {
    if (running) return 0;
    running = true;
    let sent = 0;
    try {
      const page = ctx.repos.outbox.pending();
      pruneSchedule(nextAttemptAt, page);
      for (const row of page) {
        if (ctx.clock().getTime() < (nextAttemptAt.get(row.id) ?? 0)) continue; // backing off
        const published = await publishOutboxRow(
          { hcs: ctx.hcs, outbox: ctx.repos.outbox, log: ctx.log },
          row,
        );
        if (published) {
          nextAttemptAt.delete(row.id);
          sent += 1;
          ctx.log.info(
            { outbox_id: row.id, kind: row.kind, seq: published.sequenceNumber },
            "drained outbox row",
          );
          continue;
        }
        // `publishOutboxRow` has counted the attempt and left the row `pending`; the retry budget
        // is this job's to spend, so re-read what it wrote and decide.
        retryOrRetire(ctx, row, nextAttemptAt);
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

function retryOrRetire(
  ctx: WitnessContext,
  row: OutboxRow,
  nextAttemptAt: Map<number, number>,
): void {
  const after = ctx.repos.outbox.get(row.id);
  const attempts = after?.attempts ?? row.attempts + 1;
  const lastError = after?.last_error ?? "HCS publish failed";
  if (attempts < MAX_OUTBOX_ATTEMPTS) {
    nextAttemptAt.set(row.id, ctx.clock().getTime() + backoffMs(attempts));
    return;
  }
  ctx.repos.outbox.markFailed(row.id, lastError);
  nextAttemptAt.delete(row.id);
  // Loud on purpose: this is a decision the witness made and can no longer prove it made, and an
  // operator has to replay it by hand once the topic or the submit key is fixed.
  ctx.log.error(
    {
      outbox_id: row.id,
      kind: row.kind,
      topic_id: row.topic_id,
      attempts,
      last_error: lastError,
    },
    "outbox row retired to failed after exhausting its retries; it never reached consensus",
  );
}

/**
 * `pending()` returns one page ordered by id, so any scheduled id at or below the page's last id
 * that is absent from the page has left `pending` — published by the release path, or retired
 * here. Ids above the page are simply outside the window and keep their backoff.
 */
function pruneSchedule(nextAttemptAt: Map<number, number>, page: OutboxRow[]): void {
  if (nextAttemptAt.size === 0) return;
  if (page.length === 0) {
    nextAttemptAt.clear();
    return;
  }
  const onPage = new Set(page.map((r) => r.id));
  const highWater = page[page.length - 1]?.id ?? 0;
  for (const id of nextAttemptAt.keys()) {
    if (id <= highWater && !onPage.has(id)) nextAttemptAt.delete(id);
  }
}
