import type { Db } from "./db.js";

/**
 * D28: the witness records that a share exists and what it hashes to. It stores no `b_enc` —
 * B is recomputed from `WITNESS_MASTER` on every use, and `klaxon emergency` recomputes it from
 * the paper-backed master with zero witness state.
 */
export interface ShareRow {
  project_id: string;
  secret: string;
  gen: number;
  b_hash: string;
  retired: number;
  created_at: string;
}

export class SharesRepo {
  constructor(private readonly db: Db) {}

  get(projectId: string, secret: string, gen: number): ShareRow | null {
    const row = this.db
      .prepare("SELECT * FROM shares WHERE project_id = ? AND secret = ? AND gen = ?")
      .get(projectId, secret, gen);
    return row ? ({ ...(row as object) } as ShareRow) : null;
  }

  /** First write wins (PROTOCOL §2): a second `/shares` for the same tuple changes nothing. */
  insert(row: Omit<ShareRow, "retired">): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO shares (project_id, secret, gen, b_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.project_id, row.secret, row.gen, row.b_hash, row.created_at);
    return res.changes > 0;
  }

  retire(projectId: string, secret: string, gen: number): void {
    this.db
      .prepare("UPDATE shares SET retired = 1 WHERE project_id = ? AND secret = ? AND gen = ?")
      .run(projectId, secret, gen);
  }
}
