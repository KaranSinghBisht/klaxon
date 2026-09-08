import { VerifyInfraError } from "../errors.js";

/** Injectable so every unit test runs with no network (D5's independence is only useful offline). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MirrorClientOptions {
  /** Origin or full `/api/v1` base — either form works; only the origin is kept. */
  baseUrl: string;
  fetch?: FetchLike;
  /** Attempts after the first, on 429/5xx and transport errors. */
  maxRetries?: number;
  retryBaseMs?: number;
  /** Hard stop on `links.next` chains so a looping mirror cannot hang the verifier. */
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MIRROR_URL = "https://testnet.mirrornode.hedera.com";
/** The public mirror node caps `limit` at 100 and returns no `RateLimit-*` headers (B §3.4). */
export const MIRROR_PAGE_LIMIT = 100;
/** Cap on parallel mirror requests, per B §3.4. */
export const MIRROR_CONCURRENCY = 4;

interface Links {
  next?: string | null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MirrorClient {
  readonly origin: string;
  private readonly doFetch: FetchLike;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly maxPages: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: MirrorClientOptions) {
    let origin: string;
    try {
      origin = new URL(options.baseUrl).origin;
    } catch {
      throw new VerifyInfraError(`invalid mirror node URL: ${options.baseUrl}`);
    }
    this.origin = origin;
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.maxRetries = options.maxRetries ?? 4;
    this.retryBaseMs = options.retryBaseMs ?? 250;
    this.maxPages = options.maxPages ?? 500;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** `pathAndQuery` is a mirror path such as `/api/v1/topics/0.0.1/messages?limit=100`. */
  async getJson<T>(pathAndQuery: string): Promise<T> {
    const url = pathAndQuery.startsWith("http")
      ? pathAndQuery
      : `${this.origin}${pathAndQuery.startsWith("/") ? "" : "/"}${pathAndQuery}`;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.retryBaseMs * 2 ** (attempt - 1));
      let response: Response;
      try {
        response = await this.doFetch(url, { headers: { accept: "application/json" } });
      } catch (error) {
        lastError = error;
        continue;
      }
      if (response.ok) {
        try {
          return (await response.json()) as T;
        } catch (error) {
          throw new VerifyInfraError(`mirror node returned non-JSON for ${url}`, error);
        }
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      throw new VerifyInfraError(`mirror node ${response.status} for ${url}`);
    }
    throw new VerifyInfraError(
      `mirror node unreachable after ${this.maxRetries + 1} attempts: ${url}`,
      lastError,
    );
  }

  /**
   * Follow `links.next` (a path, not an absolute URL) until it is null, flattening each page
   * through `pick`.
   */
  async collect<Page extends { links?: Links | null }, Item>(
    firstPath: string,
    pick: (page: Page) => readonly Item[] | undefined,
  ): Promise<Item[]> {
    const items: Item[] = [];
    const seen = new Set<string>();
    let path: string | null = firstPath;
    for (let page = 0; page < this.maxPages && path !== null; page++) {
      if (seen.has(path)) break; // a mirror that returns its own page as `next` would loop forever
      seen.add(path);
      const body: Page = await this.getJson<Page>(path);
      for (const item of pick(body) ?? []) items.push(item);
      const next = body.links?.next;
      path = next === undefined || next === null || next === "" ? null : next;
    }
    return items;
  }
}
