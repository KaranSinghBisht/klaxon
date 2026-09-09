import { cmpTsString } from "../timestamp.js";
import { MIRROR_PAGE_LIMIT, type MirrorClient } from "./client.js";

/** Shape verified live against the public testnet mirror node (B §3.4). */
export interface RawChunkInfo {
  initial_transaction_id: {
    account_id: string;
    transaction_valid_start: string;
    nonce?: number;
    scheduled?: boolean;
  };
  number: number;
  total: number;
}

export interface RawTopicMessage {
  chunk_info?: RawChunkInfo | null;
  consensus_timestamp: string;
  message: string;
  sequence_number: number;
  topic_id?: string;
  payer_account_id?: string;
}

export interface TopicMessage {
  /** The **last** chunk's consensus timestamp: when the whole message reached consensus. */
  consensusTimestamp: string;
  sequenceNumber: number;
  chunks: number;
  /**
   * The Hedera account that paid for the submission. The topic's submit key is a 1-of-2 KeyList
   * (PROTOCOL §7), so this is the only public evidence tying the `--witness` account the operator
   * handed us to the topic they handed us with it.
   */
  payerAccountId: string | null;
  json: unknown;
}

export interface IncompleteGroup {
  key: string;
  have: number;
  total: number;
  /** Latest consensus timestamp seen among the chunks that did arrive. */
  lastTimestamp: string;
}

export interface MalformedGroup {
  key: string;
  consensusTimestamp: string;
  reason: string;
}

export interface TopicRead {
  messages: TopicMessage[];
  incomplete: IncompleteGroup[];
  malformed: MalformedGroup[];
}

interface Part {
  number: number;
  total: number;
  b64: string;
  ts: string;
  sequence: number;
  payer: string | null;
}

function groupKey(m: RawTopicMessage): string {
  const info = m.chunk_info;
  if (!info) return `single:${m.consensus_timestamp}`;
  const id = info.initial_transaction_id;
  return `${id.account_id}@${id.transaction_valid_start}`;
}

export function topicMessagesPath(topicId: string, sinceTimestamp?: string): string {
  const query = new URLSearchParams({ limit: String(MIRROR_PAGE_LIMIT), order: "asc" });
  if (sinceTimestamp) query.set("timestamp", `gte:${sinceTimestamp}`);
  return `/api/v1/topics/${encodeURIComponent(topicId)}/messages?${query.toString()}`;
}

/**
 * Reassemble the SDK's chunking (PROTOCOL §7): group by `chunk_info.initial_transaction_id`,
 * order by `number`, require the count to equal `total`, base64-decode each chunk and
 * concatenate **bytes** before parsing. An incomplete group is reported, never dropped — that
 * distinction is what keeps a mid-ingestion read from looking like a withheld release.
 */
export function reassemble(raw: readonly RawTopicMessage[]): TopicRead {
  const groups = new Map<string, Part[]>();
  for (const m of raw) {
    const info = m.chunk_info;
    const key = groupKey(m);
    const parts = groups.get(key);
    const part: Part = {
      number: info?.number ?? 1,
      total: info?.total ?? 1,
      b64: m.message,
      ts: m.consensus_timestamp,
      sequence: m.sequence_number,
      payer: m.payer_account_id ?? null,
    };
    if (parts) parts.push(part);
    else groups.set(key, [part]);
  }

  const messages: TopicMessage[] = [];
  const incomplete: IncompleteGroup[] = [];
  const malformed: MalformedGroup[] = [];

  for (const [key, parts] of groups) {
    parts.sort((a, b) => a.number - b.number);
    const total = parts[0]?.total ?? parts.length;
    const last = parts[parts.length - 1] as Part;
    const numbers = new Set(parts.map((p) => p.number));
    if (parts.length !== total || numbers.size !== parts.length) {
      incomplete.push({ key, have: parts.length, total, lastTimestamp: last.ts });
      continue;
    }
    const bytes = Buffer.concat(parts.map((p) => Buffer.from(p.b64, "base64")));
    try {
      messages.push({
        consensusTimestamp: last.ts,
        sequenceNumber: last.sequence,
        chunks: parts.length,
        payerAccountId: last.payer,
        json: JSON.parse(bytes.toString("utf8")),
      });
    } catch (error) {
      malformed.push({
        key,
        consensusTimestamp: last.ts,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  messages.sort((a, b) => cmpTsString(a.consensusTimestamp, b.consensusTimestamp));
  incomplete.sort((a, b) => cmpTsString(a.lastTimestamp, b.lastTimestamp));
  return { messages, incomplete, malformed };
}

export async function readTopic(
  client: MirrorClient,
  topicId: string,
  sinceTimestamp?: string,
): Promise<TopicRead> {
  const raw = await client.collect<
    { messages?: RawTopicMessage[]; links?: { next?: string | null } },
    RawTopicMessage
  >(topicMessagesPath(topicId, sinceTimestamp), (page) => page.messages);
  return reassemble(raw);
}
