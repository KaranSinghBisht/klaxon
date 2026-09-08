import type { Db } from "./db.js";

export interface RefusalRow {
  id: number;
  h: string;
  project_id: string | null;
  class: string;
  check_id: number;
  reason: string;
  commitment_json: string | null;
  jwt: string | null;
  pay_tx: string | null;
  hcs_seq: string | null;
  hcs_consensus: string | null;
  created_at: string;
}

export class RefusalsRepo {
  constructor(private readonly db: Db) {}

  insert(row: Omit<RefusalRow, "id" | "hcs_seq" | "hcs_consensus">): number {
    const res = this.db
      .prepare(
        `INSERT INTO refusals
           (h, project_id, class, check_id, reason, commitment_json, jwt, pay_tx, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.h,
        row.project_id,
        row.class,
        row.check_id,
        row.reason,
        row.commitment_json,
        row.jwt,
        row.pay_tx,
        row.created_at,
      );
    return Number(res.lastInsertRowid);
  }

  setConsensus(id: number, seq: string, consensus: string): void {
    this.db
      .prepare("UPDATE refusals SET hcs_seq = ?, hcs_consensus = ? WHERE id = ?")
      .run(seq, consensus, id);
  }

  listForH(h: string): RefusalRow[] {
    return this.db
      .prepare("SELECT * FROM refusals WHERE h = ? ORDER BY id ASC")
      .all(h)
      .map((r) => ({ ...(r as object) }) as RefusalRow);
  }
}
