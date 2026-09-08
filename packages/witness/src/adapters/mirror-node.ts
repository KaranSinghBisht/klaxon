/**
 * Hedera mirror node REST reads (B §3.4). Public data, no key — the same source `verify` uses,
 * which is what makes "the constraint is checked by the party with the security interest, over
 * data any third party can re-read" literally true.
 */
export interface MirrorTransfer {
  account: string;
  amount: number;
}

export interface MirrorTransaction {
  consensus_timestamp: string;
  memo_base64: string | null;
  name: string;
  result: string;
  transaction_id: string;
  transfers: MirrorTransfer[];
}

/**
 * The SDK prints `0.0.4821@1725379200.123456789`; the mirror node's REST path wants
 * `0.0.4821-1725379200-123456789` and answers HTTP 400 for the SDK form (B §3.4, C6).
 */
export function toDashedTransactionId(txId: string): string {
  const trimmed = txId.trim();
  if (/^\d+\.\d+\.\d+-\d+-\d+$/.test(trimmed)) return trimmed;
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(trimmed);
  if (!m) return trimmed;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export class MirrorUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MirrorUnavailableError";
  }
}

export interface MirrorClientOptions {
  baseUrl: string;
  /** Mirror ingestion lags consensus by ~1–2 s, so a fresh settlement needs a moment (B §2.6). */
  attempts?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class MirrorNodeClient {
  private readonly baseUrl: string;
  private readonly attempts: number;
  private readonly delayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: MirrorClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.attempts = opts.attempts ?? 3;
    this.delayMs = opts.delayMs ?? 400;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Null means "the mirror answered, and this transaction is not there yet". */
  async getTransaction(txId: string): Promise<MirrorTransaction[] | null> {
    const url = `${this.baseUrl}/api/v1/transactions/${toDashedTransactionId(txId)}`;
    let lastError: unknown;
    for (let i = 0; i < this.attempts; i++) {
      if (i > 0) await this.sleep(this.delayMs);
      try {
        const res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
        if (res.status === 404) {
          lastError = new MirrorUnavailableError("transaction not ingested yet");
          continue;
        }
        if (!res.ok) {
          lastError = new MirrorUnavailableError(`mirror node returned ${res.status}`);
          continue;
        }
        const body = (await res.json()) as { transactions?: MirrorTransaction[] };
        const list = body.transactions ?? [];
        if (list.length === 0) {
          lastError = new MirrorUnavailableError("transaction not ingested yet");
          continue;
        }
        return list;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError instanceof MirrorUnavailableError && /not ingested/.test(lastError.message)) {
      return null;
    }
    throw new MirrorUnavailableError("mirror node unreachable", lastError);
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/v1/network/nodes?limit=1`, {
        headers: { accept: "application/json" },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export function decodeMemo(memoBase64: string | null): string {
  if (!memoBase64) return "";
  return Buffer.from(memoBase64, "base64").toString("utf8");
}

/** Tinybars credited to `account` across the transfer list, fee legs included and netted out. */
export function creditedTo(tx: MirrorTransaction, account: string): bigint {
  let total = 0n;
  for (const t of tx.transfers ?? []) {
    if (t.account === account) total += BigInt(t.amount);
  }
  return total;
}
