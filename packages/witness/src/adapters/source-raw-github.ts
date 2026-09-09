import { SourceFetchError, type SourcePort, type WorkflowFile } from "../ports/source.js";
import { OUTBOUND_TIMEOUT_MS, timeoutSignal } from "./http.js";

/**
 * D7 — policy and workflows come from `raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}`,
 * unauthenticated. That removes a secret from the witness and makes "verify uses only public
 * data" true of the witness's own inputs too: `verify` reads the identical URL.
 *
 * `listWorkflows` needs a directory listing, which raw cannot do, so it uses the unauthenticated
 * contents API. The demo path never reaches it — the OIDC token's `job_workflow_ref` names the
 * exact file, and check 5 fetches that directly.
 */
export interface RawGithubOptions {
  rawBase?: string;
  apiBase?: string;
  token?: string | undefined;
  /** Per-call deadline. A GitHub that hangs must read as an outage, not as "policy absent". */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class RawGithubSourceAdapter implements SourcePort {
  private readonly rawBase: string;
  private readonly apiBase: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RawGithubOptions = {}) {
    this.rawBase = (opts.rawBase ?? "https://raw.githubusercontent.com").replace(/\/+$/, "");
    this.apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? OUTBOUND_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = { accept };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async fetch(repo: string, sha: string, path: string): Promise<Buffer> {
    const url = `${this.rawBase}/${repo}/${sha}/${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: this.headers("text/plain"),
        signal: timeoutSignal(this.timeoutMs),
      });
    } catch (cause) {
      throw new SourceFetchError(`could not reach ${url}`, { notFound: false, cause });
    }
    if (res.status === 404) {
      throw new SourceFetchError(`${path} does not exist at ${sha}`, {
        notFound: true,
        status: 404,
      });
    }
    if (!res.ok) {
      throw new SourceFetchError(`GitHub returned ${res.status} for ${path}`, {
        notFound: false,
        status: res.status,
      });
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async listWorkflows(repo: string, sha: string): Promise<WorkflowFile[]> {
    const url = `${this.apiBase}/repos/${repo}/contents/.github/workflows?ref=${sha}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: {
          ...this.headers("application/vnd.github+json"),
          "x-github-api-version": "2022-11-28",
        },
        signal: timeoutSignal(this.timeoutMs),
      });
    } catch (cause) {
      throw new SourceFetchError("could not list workflows", { notFound: false, cause });
    }
    if (res.status === 404) {
      throw new SourceFetchError(`no .github/workflows at ${sha}`, { notFound: true, status: 404 });
    }
    if (!res.ok) {
      throw new SourceFetchError(`GitHub returned ${res.status} listing workflows`, {
        notFound: false,
        status: res.status,
      });
    }
    const entries = (await res.json()) as Array<{ type?: string; path?: string; name?: string }>;
    const files = entries.filter(
      (e) => e.type === "file" && typeof e.name === "string" && /\.ya?ml$/.test(e.name),
    );
    const out: WorkflowFile[] = [];
    for (const file of files) {
      if (!file.path) continue;
      out.push({ path: file.path, bytes: await this.fetch(repo, sha, file.path) });
    }
    return out;
  }
}
