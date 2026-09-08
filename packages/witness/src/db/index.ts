import { CursorRepo } from "./cursor.js";
import type { Db } from "./db.js";
import { JwksSnapshotsRepo } from "./jwks-snapshots.js";
import { OutboxRepo } from "./outbox.js";
import { ProjectsRepo } from "./projects.js";
import { RefusalsRepo } from "./refusals.js";
import { ReleasesRepo } from "./releases.js";
import { RevocationRepo } from "./revocation.js";
import { SharesRepo } from "./shares.js";
import { WorkflowCacheRepo } from "./workflow-cache.js";

export interface Repos {
  projects: ProjectsRepo;
  shares: SharesRepo;
  releases: ReleasesRepo;
  refusals: RefusalsRepo;
  revocation: RevocationRepo;
  outbox: OutboxRepo;
  cursor: CursorRepo;
  jwks: JwksSnapshotsRepo;
  workflowCache: WorkflowCacheRepo;
}

export function createRepos(db: Db): Repos {
  return {
    projects: new ProjectsRepo(db),
    shares: new SharesRepo(db),
    releases: new ReleasesRepo(db),
    refusals: new RefusalsRepo(db),
    revocation: new RevocationRepo(db),
    outbox: new OutboxRepo(db),
    cursor: new CursorRepo(db),
    jwks: new JwksSnapshotsRepo(db),
    workflowCache: new WorkflowCacheRepo(db),
  };
}

export { CursorRepo, SEPOLIA_CURSOR_KEY } from "./cursor.js";
export { type Db, immediateTransaction, isUniqueViolation, nowIso, openDb } from "./db.js";
export { JwksSnapshotsRepo } from "./jwks-snapshots.js";
export { type OutboxKind, OutboxRepo, type OutboxRow } from "./outbox.js";
export { type NewProject, type ProjectRow, ProjectsRepo } from "./projects.js";
export { type RefusalRow, RefusalsRepo } from "./refusals.js";
export { type ReleaseRow, ReleasesRepo } from "./releases.js";
export { RevocationRepo, type RevocationRow } from "./revocation.js";
export { type ShareRow, SharesRepo } from "./shares.js";
export { WorkflowCacheRepo } from "./workflow-cache.js";
