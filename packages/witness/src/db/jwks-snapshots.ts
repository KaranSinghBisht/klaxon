import { sha256 } from "@klaxon/core";
import type { Db } from "./db.js";

export interface JwksSnapshotRow {
  id: number;
  fetched_at: string;
  jwks_json: string;
  sha256: string;
  hcs_seq: string | null;
  hcs_consensus: string | null;
}

/**
 * The daily JWKS snapshot (B §5.6). GitHub rotates its signing keys, so `verify` needs a record of
 * what the keyset was when a token was issued. Deduped by content hash: an unchanged day writes
 * nothing and publishes nothing.
 */
export class JwksSnapshotsRepo {
  constructor(private readonly db: Db) {}

  /** Returns the row id when the snapshot is new, or null when today's keyset is unchanged. */
  insertIfNew(jwks: unknown, at: string): { id: number; digest: string } | null {
    const json = JSON.stringify(jwks);
    const digest = sha256(json).toString("hex");
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO jwks_snapshots (fetched_at, jwks_json, sha256) VALUES (?, ?, ?)`,
      )
      .run(at, json, digest);
    return res.changes > 0 ? { id: Number(res.lastInsertRowid), digest } : null;
  }

  setConsensus(id: number, seq: string, consensus: string): void {
    this.db
      .prepare("UPDATE jwks_snapshots SET hcs_seq = ?, hcs_consensus = ? WHERE id = ?")
      .run(seq, consensus, id);
  }

  latest(): JwksSnapshotRow | null {
    const row = this.db.prepare("SELECT * FROM jwks_snapshots ORDER BY id DESC LIMIT 1").get();
    return row ? ({ ...(row as object) } as JwksSnapshotRow) : null;
  }
}
