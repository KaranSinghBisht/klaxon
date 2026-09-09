import type { Db } from "./db.js";

export type OutboxKind =
  | "released"
  | "refused"
  | "rotate"
  | "revoke"
  | "unrevoke"
  | "jwks"
  | "emergency";

export interface OutboxRow {
  id: number;
  topic_id: string;
  payload: string;
  kind: OutboxKind;
  state: "pending" | "sent" | "failed";
  attempts: number;
  last_error: string | null;
  seq: string | null;
  consensus: string | null;
  created_at: string;
}

/**
 * D23. A crash between "decided to release" and "published to HCS" would leave a settled payment
 * with no message, and `verify` would correctly call an honest witness `WITNESS WITHHELD`. The
 * intent to publish is written inside the same transaction as the decision; the drain job retries.
 */
export class OutboxRepo {
  constructor(private readonly db: Db) {}

  enqueue(topicId: string, kind: OutboxKind, payload: unknown, createdAt: string): number {
    const res = this.db
      .prepare(
        `INSERT INTO hcs_outbox (topic_id, payload, kind, state, created_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      )
      .run(topicId, JSON.stringify(payload), kind, createdAt);
    return Number(res.lastInsertRowid);
  }

  get(id: number): OutboxRow | null {
    const row = this.db.prepare("SELECT * FROM hcs_outbox WHERE id = ?").get(id);
    return row ? ({ ...(row as object) } as OutboxRow) : null;
  }

  pending(limit = 20): OutboxRow[] {
    return this.db
      .prepare("SELECT * FROM hcs_outbox WHERE state = 'pending' ORDER BY id ASC LIMIT ?")
      .all(limit)
      .map((r) => ({ ...(r as object) }) as OutboxRow);
  }

  markSent(id: number, seq: string, consensus: string): void {
    this.db
      .prepare(
        "UPDATE hcs_outbox SET state = 'sent', seq = ?, consensus = ?, attempts = attempts + 1 WHERE id = ?",
      )
      .run(seq, consensus, id);
  }

  /** Stays `pending` so the drain retries; `last_error` is for the operator, never for the client. */
  markAttemptFailed(id: number, error: string): void {
    this.db
      .prepare("UPDATE hcs_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?")
      .run(error, id);
  }

  /**
   * Retired. Only the drain writes this, and only after it has spent the row's whole retry budget:
   * a row that has failed that many times is poison — a deleted topic, a rotated submit key — and
   * leaving it `pending` at the head of the queue would keep every later `released` and `refused`
   * off the ledger, which is the one thing the outbox exists to prevent (D23).
   *
   * The payload stays in the table. An operator who fixes the topic can replay it by hand; nothing
   * about the decision is lost, only its consensus timestamp.
   */
  markFailed(id: number, error: string): void {
    this.db
      .prepare("UPDATE hcs_outbox SET state = 'failed', last_error = ? WHERE id = ?")
      .run(error, id);
  }

  countByState(state: OutboxRow["state"]): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM hcs_outbox WHERE state = ?")
      .get(state) as { n: number } | undefined;
    return row?.n ?? 0;
  }
}
