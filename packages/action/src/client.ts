import { x402Client } from "@x402/core/client";
import type { Network, PaymentRequirements } from "@x402/core/types";
import type { PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { klaxonSigner } from "./signer.js";

/** CAIP-2, colon form — `hedera-testnet` is the v1 spelling and is not what Blocky402 advertises. */
export const HEDERA_TESTNET: Network = "hedera:testnet";
/** x402's asset id for native HBAR. Amounts are tinybars. */
export const HBAR_ASSET = "0.0.0";

export interface PayClientOptions {
  payAccount: string;
  payKey: PrivateKey;
  /** The account the configured witness advertises in its manifest. */
  witnessAccount: string;
  /** Hard per-payment cap in tinybars, from the `max-tinybars` input. */
  maxTinybars: string;
}

/**
 * Anti-redirect policy (D10): drop every requirement that would pay someone other than the witness
 * this job was pointed at. Without it a redirected 402 could route the runner's payment elsewhere.
 */
export function witnessOnlyPolicy(
  witnessAccount: string,
): (x402Version: number, reqs: PaymentRequirements[]) => PaymentRequirements[] {
  return (_x402Version, reqs) => reqs.filter((r) => r.payTo === witnessAccount);
}

/**
 * `spendControls.allowedAssets` is not optional (D10/C5): the client's default allows only assets
 * `findDefaultAsset` recognizes — Hedera's defaults are USDC-only — so an unconfigured client
 * rejects every KLAXON 402 before it ever reaches the signer.
 */
export function buildPayClient(o: PayClientOptions): x402Client {
  return x402Client.fromConfig({
    schemes: [
      {
        network: HEDERA_TESTNET,
        client: new ExactHederaScheme(klaxonSigner(o.payAccount, o.payKey)),
      },
    ],
    spendControls: {
      allowedAssets: [
        { network: HEDERA_TESTNET, asset: HBAR_ASSET, maxAmountPerPayment: o.maxTinybars },
      ],
    },
    policies: [witnessOnlyPolicy(o.witnessAccount)],
  });
}
