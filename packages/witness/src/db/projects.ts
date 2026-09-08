import type { Db } from "./db.js";

export interface ProjectRow {
  project_id: string;
  repository: string;
  repository_id: string;
  member_pubkey: string;
  owner_address: string | null;
  topic_id: string;
  ntfy_topic: string | null;
  policy_hash: string | null;
  policy_block: number | null;
  current_gen: number;
  max_releases: number;
  revoked: number;
  local_epoch: number;
  chain_epoch: number;
  created_at: string;
}

export interface NewProject {
  project_id: string;
  repository: string;
  repository_id: string;
  member_pubkey: string;
  topic_id: string;
  ntfy_topic: string | null;
  max_releases: number;
  created_at: string;
}

/** `node:sqlite` hands back null-prototype rows; a cast is the honest way to name their shape. */
function asRow<T>(row: unknown): T | null {
  return row === undefined || row === null ? null : ({ ...(row as object) } as T);
}

export class ProjectsRepo {
  constructor(private readonly db: Db) {}

  get(projectId: string): ProjectRow | null {
    return asRow<ProjectRow>(
      this.db.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId),
    );
  }

  list(): ProjectRow[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY created_at ASC")
      .all()
      .map((r) => ({ ...(r as object) }) as ProjectRow);
  }

  /** First write wins: re-registering an existing project id is a no-op, not an overwrite. */
  insert(p: NewProject): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO projects
           (project_id, repository, repository_id, member_pubkey, topic_id, ntfy_topic,
            max_releases, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.project_id,
        p.repository,
        p.repository_id,
        p.member_pubkey,
        p.topic_id,
        p.ntfy_topic,
        p.max_releases,
        p.created_at,
      );
    return res.changes > 0;
  }

  setPolicyAnchor(projectId: string, hash: string, block: number): void {
    this.db
      .prepare("UPDATE projects SET policy_hash = ?, policy_block = ? WHERE project_id = ?")
      .run(hash, block, projectId);
  }

  setOwner(projectId: string, owner: string): void {
    this.db
      .prepare("UPDATE projects SET owner_address = ? WHERE project_id = ?")
      .run(owner, projectId);
  }

  /** Chain epoch caught up with the local one → the project is live again (PROTOCOL §6 check 8). */
  setChainEpoch(projectId: string, epoch: number): void {
    this.db
      .prepare(
        `UPDATE projects
            SET chain_epoch = ?,
                revoked = CASE WHEN ? >= local_epoch THEN 0 ELSE revoked END
          WHERE project_id = ?`,
      )
      .run(epoch, epoch, projectId);
  }

  setCurrentGen(projectId: string, gen: number): void {
    this.db.prepare("UPDATE projects SET current_gen = ? WHERE project_id = ?").run(gen, projectId);
  }
}
