import { CHAIN } from "./facts";

export const MIRROR = "https://testnet.mirrornode.hedera.com";

export type Claims = {
  secret?: string;
  environment?: string;
  gen?: string;
  run_id?: string;
  run_attempt?: string;
};

export type AuditRecord = {
  type?: string;
  ts?: string;
  h?: string;
  pay_tx?: string;
  C?: Claims;
  check?: number;
  class?: string;
  reason?: string;
  epoch?: string;
  sepolia_tx?: string;
};

export type Entry = { body: AuditRecord | null; seqs: number[]; at: string };

const decode = (b64: string): string =>
  typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");

/**
 * HCS caps a message near 1 KB, so a record carrying a whole OIDC token arrives in several. The
 * pieces are grouped by the transaction that started them, ordered, and concatenated.
 */
export function reassemble(messages: unknown[]): Entry[] {
  const groups = new Map<string, { n: number; m: Record<string, unknown> }[]>();
  for (const raw of messages) {
    const m = raw as Record<string, unknown>;
    const ci = (m.chunk_info ?? {}) as {
      initial_transaction_id?: { account_id?: string; transaction_valid_start?: string };
      number?: number;
    };
    const key = ci.initial_transaction_id
      ? `${ci.initial_transaction_id.account_id}@${ci.initial_transaction_id.transaction_valid_start}`
      : `solo-${m.sequence_number}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push({ n: ci.number ?? 1, m });
  }

  const out: Entry[] = [];
  for (const parts of groups.values()) {
    parts.sort((a, b) => a.n - b.n);
    const text = parts.map((p) => decode(String(p.m.message))).join("");
    const last = parts[parts.length - 1].m;
    let body: AuditRecord | null = null;
    try {
      body = JSON.parse(text) as AuditRecord;
    } catch {
      body = null;
    }
    out.push({
      body,
      seqs: parts.map((p) => Number(p.m.sequence_number)),
      at: String(last.consensus_timestamp),
    });
  }
  return out.sort((a, b) => Number(b.at) - Number(a.at));
}

type TopicPage = { messages?: unknown[]; links?: { next?: string | null } };

/**
 * Read the whole topic. Used on the server so the page is never served empty, and again in the
 * browser. The mirror node pages at 100 messages and a record is three of them, so without
 * following `links.next` the trail would silently stop growing at about thirty records.
 */
export async function readTopic(signal?: AbortSignal): Promise<Entry[]> {
  const messages: unknown[] = [];
  let path: string | null = `/api/v1/topics/${CHAIN.topic}/messages?limit=100&order=asc`;
  for (let page = 0; path && page < 20; page++) {
    const res = await fetch(`${MIRROR}${path}`, { signal, next: { revalidate: 60 } } as RequestInit);
    if (!res.ok) throw new Error(`mirror node answered ${res.status}`);
    const body = (await res.json()) as TopicPage;
    messages.push(...(body.messages ?? []));
    path = body.links?.next ?? null;
  }
  return reassemble(messages);
}

export type Proof = { state: "ok" | "bad" | "unknown"; detail: string };

const dashed = (id: string): string | null => {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(id ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/**
 * The check the whole page exists for: fetch the payment named in the record and confirm its
 * transaction memo IS the commitment hash. Runs on the server so the answer is already on screen,
 * and again in the browser so the reader can watch it happen against Hedera rather than trust us.
 */
export async function proveMemo(payTx?: string, h?: string): Promise<Proof> {
  const id = payTx ? dashed(payTx) : null;
  if (!id || !h) return { state: "unknown", detail: "no payment named in the record" };
  try {
    const res = await fetch(`${MIRROR}/api/v1/transactions/${id}`, {
      next: { revalidate: 300 },
    } as RequestInit);
    if (!res.ok) return { state: "unknown", detail: `mirror node answered ${res.status}` };
    const tx = ((await res.json()) as { transactions?: Record<string, unknown>[] }).transactions?.[0];
    if (!tx) return { state: "unknown", detail: "not indexed yet" };
    const memo = tx.memo_base64 ? decode(String(tx.memo_base64)) : "";
    const credit = ((tx.transfers ?? []) as { account: string; amount: number }[]).find(
      (t) => t.account === CHAIN.witnessAccount && t.amount > 0,
    );
    return memo === h
      ? {
          state: "ok",
          detail: `memo is the commitment · witness credited ${credit ? credit.amount.toLocaleString("en-US") : "?"} tinybar`,
        }
      : { state: "bad", detail: `memo does not match this commitment` };
  } catch {
    return { state: "unknown", detail: "could not reach the mirror node" };
  }
}

/** Every proof for a page of entries, resolved together. */
export async function proveAll(entries: Entry[]): Promise<Record<string, Proof>> {
  const pairs = await Promise.all(
    entries
      .filter((e) => e.body && e.body.type !== "unrevoke")
      .map(async (e) => [e.seqs.join("-"), await proveMemo(e.body?.pay_tx, e.body?.h)] as const),
  );
  return Object.fromEntries(pairs);
}
