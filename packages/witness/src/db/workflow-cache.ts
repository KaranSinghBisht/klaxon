import type { Db } from "./db.js";

/**
 * B §5.3: keyed by `(repository, sha, path)`. A commit sha is immutable, so a hit is always
 * correct and the cache never needs invalidation. A *miss* during a GitHub outage must still
 * fail closed with `class: infra` — never serve "no install step found" from an empty read.
 */
export class WorkflowCacheRepo {
  constructor(private readonly db: Db) {}

  get(repository: string, sha: string, path: string): string | null {
    const row = this.db
      .prepare("SELECT content FROM workflow_cache WHERE repository = ? AND sha = ? AND path = ?")
      .get(repository, sha, path) as { content: string } | undefined;
    return row?.content ?? null;
  }

  put(repository: string, sha: string, path: string, content: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO workflow_cache (repository, sha, path, content, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repository, sha, path) DO NOTHING`,
      )
      .run(repository, sha, path, content, at);
  }
}
