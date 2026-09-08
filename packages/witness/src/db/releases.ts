import type { Db } from "./db.js";

export interface ReleaseRow {
  h: string;
  project_id: string;
  secret: string;
  gen: number;
  environment: string;
  run_id: string;
  run_attempt: string;
  commitment_json: string;
  jwt: string;
  sig: string;
  pay_tx: string;
  outbox_id: number | null;
  hcs_seq: string | null;
  hcs_consensus: string | null;
  created_at: string;
}

export class ReleasesRepo {
  constructor(private readonly db: Db) {}

  get(h: string): ReleaseRow | null {
    const row = this.db.prepare("SELECT * FROM releases WHERE h = ?").get(h);
    return row ? ({ ...(row as object) } as ReleaseRow) : null;
  }

  /** Check 9. The PK on `h` and the unique index on `pay_tx` are the enforcement; both throw. */
  insert(row: Omit<ReleaseRow, "outbox_id" | "hcs_seq" | "hcs_consensus">): void {
    this.db
      .prepare(
        `INSERT INTO releases
           (h, project_id, secret, gen, environment, run_id, run_attempt,
            commitment_json, jwt, sig, pay_tx, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.h,
        row.project_id,
        row.secret,
        row.gen,
        row.environment,
        row.run_id,
        row.run_attempt,
        row.commitment_json,
        row.jwt,
        row.sig,
        row.pay_tx,
        row.created_at,
      );
  }

  /** Check 7: releases already spent for this `(project, secret, gen)`, counted inside the txn. */
  countForGeneration(projectId: string, secret: string, gen: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM releases WHERE project_id = ? AND secret = ? AND gen = ?")
      .get(projectId, secret, gen) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  linkOutbox(h: string, outboxId: number): void {
    this.db.prepare("UPDATE releases SET outbox_id = ? WHERE h = ?").run(outboxId, h);
  }

  setConsensus(h: string, seq: string, consensus: string): void {
    this.db
      .prepare("UPDATE releases SET hcs_seq = ?, hcs_consensus = ? WHERE h = ?")
      .run(seq, consensus, h);
  }
}
