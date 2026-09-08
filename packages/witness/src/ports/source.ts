/**
 * Repository content at an immutable commit sha. Default adapter is raw.githubusercontent with no
 * token (D7) — the same unauthenticated path `verify` uses, so the witness's inputs are public too.
 */
export interface WorkflowFile {
  path: string;
  bytes: Buffer;
}

/**
 * A fetch failure has to keep "the file is not there" separate from "GitHub is unwell": the first
 * is a policy refusal, the second is `infra` and must never revoke (B §5.7).
 */
export class SourceFetchError extends Error {
  readonly notFound: boolean;
  readonly status: number | undefined;
  constructor(message: string, opts: { notFound: boolean; status?: number; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "SourceFetchError";
    this.notFound = opts.notFound;
    this.status = opts.status;
  }
}

export interface SourcePort {
  /** `repo` is "owner/name". Throws `SourceFetchError`; never returns an empty buffer for a 404. */
  fetch(repo: string, sha: string, path: string): Promise<Buffer>;
  /** Every `.github/workflows/*.y{a,}ml` at `sha`. Only used when the JWT names no workflow ref. */
  listWorkflows(repo: string, sha: string): Promise<WorkflowFile[]>;
}
