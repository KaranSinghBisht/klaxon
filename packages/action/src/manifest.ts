/** The subset of `GET /.well-known/klaxon.json` (PROTOCOL §4) the action needs. */
export interface WitnessManifest {
  hedera_account: string;
  price?: { amount: string; asset: string; network: string };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Strips trailing slashes so `${base}/release/${h}` never doubles up. */
export function normalizeWitness(witness: string): string {
  return witness.trim().replace(/\/+$/, "");
}

/**
 * Reads the account the witness says it is paid at. This is the anti-redirect anchor (D10): the
 * x402 client will only sign a 402 whose `payTo` equals this value, so a redirected or spoofed
 * payment request cannot divert the runner's HBAR to another account.
 */
export async function fetchWitnessAccount(witness: string, f: FetchLike): Promise<string> {
  const url = `${normalizeWitness(witness)}/.well-known/klaxon.json`;
  let res: Response;
  try {
    res = await f(url, { method: "GET", headers: { accept: "application/json" } });
  } catch (cause) {
    throw new Error(`KLAXON: cannot reach the witness manifest at ${url}`, { cause });
  }
  if (!res.ok) {
    throw new Error(`KLAXON: witness manifest at ${url} returned HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    throw new Error(`KLAXON: witness manifest at ${url} is not JSON`, { cause });
  }
  const account = (body as Partial<WitnessManifest> | null)?.hedera_account;
  if (typeof account !== "string" || !/^\d+\.\d+\.\d+$/.test(account)) {
    throw new Error(`KLAXON: witness manifest at ${url} has no usable hedera_account`);
  }
  return account;
}
