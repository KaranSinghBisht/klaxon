import { SourceFetchError, type SourcePort, type WorkflowFile } from "../../src/ports/index.js";

/** Serves fixture bytes at a fixed `(repo, sha, path)`. A missing key is a 404, not an outage. */
export class FakeSourcePort implements SourcePort {
  private readonly files = new Map<string, Buffer>();
  /** When true, every read throws a non-404 error so checks must classify it as `infra`. */
  down = false;

  private key(repo: string, sha: string, path: string): string {
    return `${repo}@${sha}:${path}`;
  }

  put(repo: string, sha: string, path: string, content: string | Buffer): void {
    this.files.set(
      this.key(repo, sha, path),
      typeof content === "string" ? Buffer.from(content, "utf8") : content,
    );
  }

  async fetch(repo: string, sha: string, path: string): Promise<Buffer> {
    if (this.down) throw new SourceFetchError("github is down", { notFound: false, status: 503 });
    const bytes = this.files.get(this.key(repo, sha, path));
    if (!bytes) {
      throw new SourceFetchError(`${path} not found at ${sha}`, { notFound: true, status: 404 });
    }
    return bytes;
  }

  async listWorkflows(repo: string, sha: string): Promise<WorkflowFile[]> {
    if (this.down) throw new SourceFetchError("github is down", { notFound: false, status: 503 });
    const prefix = `${repo}@${sha}:.github/workflows/`;
    const out: WorkflowFile[] = [];
    for (const [key, bytes] of this.files) {
      if (key.startsWith(prefix)) out.push({ path: key.slice(`${repo}@${sha}:`.length), bytes });
    }
    return out;
  }
}
