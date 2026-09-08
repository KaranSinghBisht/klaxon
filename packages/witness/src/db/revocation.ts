import type { Db } from "./db.js";

export interface RevocationRow {
  project_id: string;
  revoked_at: string;
  reason: string;
  h: string | null;
  epoch: number;
}

/**
 * Revoking advances `projects.local_epoch`; check 8 then refuses until the Sepolia watcher sees an
 * `Unrevoked(p, epoch)` that catches `chain_epoch` up. The device is the only way back.
 */
export class RevocationRepo {
  constructor(private readonly db: Db) {}

  get(projectId: string): RevocationRow | null {
    const row = this.db.prepare("SELECT * FROM revocation WHERE project_id = ?").get(projectId);
    return row ? ({ ...(row as object) } as RevocationRow) : null;
  }

  /** Returns the new epoch. Safe to call on an already-revoked project. */
  revoke(projectId: string, reason: string, h: string | null, at: string): number {
    const cur = this.db
      .prepare("SELECT local_epoch FROM projects WHERE project_id = ?")
      .get(projectId) as { local_epoch: number } | undefined;
    const epoch = (cur?.local_epoch ?? 0) + 1;
    this.db
      .prepare("UPDATE projects SET revoked = 1, local_epoch = ? WHERE project_id = ?")
      .run(epoch, projectId);
    this.db
      .prepare(
        `INSERT INTO revocation (project_id, revoked_at, reason, h, epoch)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           revoked_at = excluded.revoked_at,
           reason     = excluded.reason,
           h          = excluded.h,
           epoch      = excluded.epoch`,
      )
      .run(projectId, at, reason, h, epoch);
    return epoch;
  }
}
