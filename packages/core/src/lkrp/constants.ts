/** Read out of the wallet-cli 2.1.0 binary. A change here silently breaks every `.enc` — hence recorded in the file. */
export const LKRP_APPLICATION_ID = 17;
export const LKRP_SDK_NAME = "wallet-cli";
export const TRUSTCHAIN_API_PROD = "https://trustchain.api.live.ledger.com";
export const TRUSTCHAIN_API_STAGING = "https://trustchain-backend.api.aws.stg.ldg-tech.com";

/** wallet-cli `ring encrypt --key <name>` derives a per-name AES key with this HKDF salt. */
export const DOMAIN_KEY_SALT = "wallet-cli-domain-v1";
export const SHARE_A_ALG = "lkrp-wallet-cli-domain-v1" as const;

/** Share A key name convention — distinct per generation so a gen-N key never opens gen N+1. */
export function shareAKeyName(projectId: string, secret: string, gen: string): string {
  return `klaxon/${projectId}/${secret}/${gen}`;
}
