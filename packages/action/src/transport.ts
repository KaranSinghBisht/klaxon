import type {
  ReleaseRefused,
  ReleaseRequestBody,
  ReleaseResponse,
  ReleaseTransport,
} from "@klaxon/core";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { type FetchLike, normalizeWitness } from "./manifest.js";

export interface KlaxonReleaseTransport extends ReleaseTransport {
  /**
   * The last `{ok:false}` body the witness returned. `getSecret` collapses every refusal into one
   * error, so the action keeps the structured body here to surface class/check/reason (B §1.6).
   */
  lastRefusal(): ReleaseRefused | null;
}

function isReleaseResponse(v: unknown): v is ReleaseResponse {
  return typeof v === "object" && v !== null && typeof (v as { ok?: unknown }).ok === "boolean";
}

/** The Hedera transaction id of the settled payment, which the witness never puts in the body. */
function payTxFrom(header: string | null, status: number): string {
  if (header === null || header.length === 0) {
    // A refusal can arrive before settlement (402/503), so only a paid 200 must carry the header.
    if (status === 200) {
      throw new Error("KLAXON: witness returned a release with no PAYMENT-RESPONSE header");
    }
    return "";
  }
  return decodePaymentResponseHeader(header).transaction;
}

/**
 * `POST /release/:h` over a payment-aware fetch. One call does 402 → memo-stamped transfer → retry;
 * `pay_tx` comes back in the `PAYMENT-RESPONSE` header because the witness learns it from
 * settlement and the body never carries it (PROTOCOL §2).
 */
export function httpReleaseTransport(
  witness: string,
  payFetch: FetchLike,
  /** Handed to the signer so it can refuse to stamp any commitment but the one we are requesting. */
  expected: { h: string | null } = { h: null },
): KlaxonReleaseTransport {
  const base = normalizeWitness(witness);
  let refusal: ReleaseRefused | null = null;

  return {
    lastRefusal: () => refusal,
    async release(h: string, body: ReleaseRequestBody) {
      // Before any 402 can be answered: this, and nothing else, is what we will pay to commit to.
      expected.h = h;
      const url = `${base}/release/${h}`;
      let res: Response;
      try {
        res = await payFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (cause) {
        throw new Error(`KLAXON: release POST to ${url} failed with no response`, { cause });
      }

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        throw new Error(`KLAXON: witness answered ${res.status} with a non-JSON body`, { cause });
      }
      if (!isReleaseResponse(parsed)) {
        throw new Error(`KLAXON: witness answered ${res.status} with an unrecognised body`);
      }

      refusal = parsed.ok ? null : parsed;
      return {
        status: res.status,
        body: parsed,
        payTx: payTxFrom(res.headers.get("PAYMENT-RESPONSE"), res.status),
      };
    },
  };
}
