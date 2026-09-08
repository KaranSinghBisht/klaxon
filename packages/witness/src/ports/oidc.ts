import type { JWTVerifyGetKey } from "jose";

/**
 * GitHub's OIDC issuer. A port because check 2 has to be driven by a fake issuer in tests — a
 * local `jose` RS256 keypair behind `createLocalJWKSet` — so hostile claim sets can be minted
 * without a GitHub Actions run (A §7.2).
 */
export interface OidcPort {
  readonly issuer: string;
  /** `createRemoteJWKSet` in production, `createLocalJWKSet` in tests. */
  readonly keys: JWTVerifyGetKey;
  /** The raw JWKS document, for the daily HCS snapshot (B §5.6). */
  fetchJwks(): Promise<{ keys: unknown[] }>;
}
