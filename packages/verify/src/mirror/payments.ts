import { HEX64 } from "../schema.js";
import { cmpTsString } from "../timestamp.js";
import { MIRROR_PAGE_LIMIT, type MirrorClient } from "./client.js";

export interface RawTransfer {
  account: string;
  amount: number;
  is_approval?: boolean;
}

/** Shape verified live against the public testnet mirror node (B §3.4). */
export interface RawTransaction {
  consensus_timestamp: string;
  memo_base64?: string | null;
  name?: string;
  result: string;
  transaction_id: string;
  transfers?: RawTransfer[];
  charged_tx_fee?: number;
  payer_account_id?: string;
}

export interface Payment {
  /** Dashed form, as the mirror node returns it. */
  transactionId: string;
  consensusTimestamp: string;
  /** The 64-hex commitment hash the runner put in the transaction memo. */
  memo: string;
  /** Net tinybars credited to the witness account. */
  amount: bigint;
}

/**
 * The x402 price a release costs, in tinybar. It is neither on Sepolia nor in the policy: the
 * only place it is published is the witness's own manifest (PROTOCOL §4), which is the audited
 * party's word. So it is an *input* to this verifier rather than something it re-derives —
 * `--price-tinybar`, defaulting to the witness's own default for `X402_PRICE_TINYBAR`, with the
 * value actually used printed in the report.
 */
export const DEFAULT_PRICE_TINYBAR = 100_000n;

export interface PaymentRead {
  payments: Payment[];
  /** Settled transfers with a commitment memo that credited the witness less than the price. */
  belowPrice: number;
}

/**
 * `0.0.X@1788848300.493972399` → `0.0.X-1788848300-493972399`.
 *
 * The SDK's `@` form returns HTTP 400 from the mirror node (C6), and the witness records
 * whichever form its x402 settlement handed it, so every id is normalised before it is used.
 */
export function toDashedTxId(id: string): string {
  const at = id.indexOf("@");
  if (at === -1) return id;
  const account = id.slice(0, at);
  const rest = id.slice(at + 1);
  const dot = rest.indexOf(".");
  if (dot === -1) return `${account}-${rest}`;
  return `${account}-${rest.slice(0, dot)}-${rest.slice(dot + 1)}`;
}

/** Pairing key: dashed, with nanoseconds zero-padded so `-1-1` and `-1-000000001` agree. */
export function txIdKey(id: string): string {
  const dashed = toDashedTxId(id.trim());
  const parts = dashed.split("-");
  const nanos = parts.length === 3 ? parts[2] : undefined;
  if (parts.length !== 3 || nanos === undefined || !/^\d{1,9}$/.test(nanos)) return dashed;
  return `${parts[0]}-${parts[1]}-${nanos.padStart(9, "0")}`;
}

export function paymentsPath(witnessAccount: string, sinceTimestamp?: string): string {
  const query = new URLSearchParams({
    "account.id": witnessAccount,
    transactiontype: "CRYPTOTRANSFER",
    order: "asc",
    limit: String(MIRROR_PAGE_LIMIT),
  });
  if (sinceTimestamp) query.set("timestamp", `gte:${sinceTimestamp}`);
  return `/api/v1/transactions?${query.toString()}`;
}

function decodeMemo(memoBase64: string | null | undefined): string {
  if (!memoBase64) return "";
  return Buffer.from(memoBase64, "base64").toString("utf8").trim();
}

/** Net credit to the witness. The fee payer is Blocky402, so `payer_account_id` proves nothing. */
function netCredit(transfers: readonly RawTransfer[] | undefined, account: string): bigint {
  let total = 0n;
  for (const t of transfers ?? []) {
    if (t.account === account) total += BigInt(t.amount);
  }
  return total;
}

/**
 * Keep only settled crypto transfers that carry a commitment hash as their memo and credited the
 * witness at least the price of a release (PROTOCOL §5, A §6.2).
 *
 * The floor is not decoration. The witness account id is published in the manifest, so without
 * one anybody could send a single tinybar with any 64-hex memo, and `verify` would report a
 * payment the witness never answered — a permanent WITNESS WITHHELD manufactured by a stranger
 * for the price of dust. Credits below the price are counted and reported, never silently lost.
 */
export function selectPayments(
  raw: readonly RawTransaction[],
  witnessAccount: string,
  minTinybar: bigint = DEFAULT_PRICE_TINYBAR,
): PaymentRead {
  const payments: Payment[] = [];
  let belowPrice = 0;
  for (const tx of raw) {
    if (tx.result !== "SUCCESS") continue;
    const memo = decodeMemo(tx.memo_base64);
    if (!HEX64.test(memo)) continue;
    const amount = netCredit(tx.transfers, witnessAccount);
    if (amount <= 0n) continue;
    if (amount < minTinybar) {
      belowPrice += 1;
      continue;
    }
    payments.push({
      transactionId: toDashedTxId(tx.transaction_id),
      consensusTimestamp: tx.consensus_timestamp,
      memo,
      amount,
    });
  }
  payments.sort((a, b) => cmpTsString(a.consensusTimestamp, b.consensusTimestamp));
  return { payments, belowPrice };
}

export async function readPayments(
  client: MirrorClient,
  witnessAccount: string,
  sinceTimestamp?: string,
  minTinybar: bigint = DEFAULT_PRICE_TINYBAR,
): Promise<PaymentRead> {
  const raw = await client.collect<
    { transactions?: RawTransaction[]; links?: { next?: string | null } },
    RawTransaction
  >(paymentsPath(witnessAccount, sinceTimestamp), (page) => page.transactions);
  return selectPayments(raw, witnessAccount, minTinybar);
}
