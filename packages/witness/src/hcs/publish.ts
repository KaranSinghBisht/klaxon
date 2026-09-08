import type { OutboxRepo, OutboxRow } from "../db/index.js";
import type { Logger } from "../log.js";
import type { HcsPort, HcsPublished } from "../ports/index.js";

/**
 * Drains one outbox row. Used both on the release critical path (publish-then-return-B, A §5.3)
 * and by the background drain job that picks up whatever a crash left `pending`.
 *
 * Returns null on failure and leaves the row `pending`, so the drain retries it. The caller
 * decides what that means for the HTTP response — on the release path it is a 503.
 */
export async function publishOutboxRow(
  deps: { hcs: HcsPort; outbox: OutboxRepo; log: Logger },
  row: OutboxRow,
): Promise<HcsPublished | null> {
  try {
    const published = await deps.hcs.publish(row.topic_id, JSON.parse(row.payload));
    deps.outbox.markSent(row.id, published.sequenceNumber, published.consensusTimestamp);
    return published;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.outbox.markAttemptFailed(row.id, message);
    deps.log.error(
      { outbox_id: row.id, kind: row.kind, topic_id: row.topic_id, err },
      "HCS publish failed; row stays pending",
    );
    return null;
  }
}

export async function publishOutboxId(
  deps: { hcs: HcsPort; outbox: OutboxRepo; log: Logger },
  id: number,
): Promise<HcsPublished | null> {
  const row = deps.outbox.get(id);
  if (!row) return null;
  if (row.state === "sent" && row.seq && row.consensus) {
    return { sequenceNumber: row.seq, consensusTimestamp: row.consensus };
  }
  return publishOutboxRow(deps, row);
}
