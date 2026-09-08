import { createRemoteJWKSet } from "jose";
import type { WitnessConfig } from "../env.js";
import type { OidcPort } from "../ports/index.js";

/**
 * GitHub's OIDC issuer (B §5.6). `createRemoteJWKSet` caches and rate-limits refetches on its own;
 * the daily raw snapshot is separate and exists so `verify` can validate a token whose `kid` has
 * since rotated out of the live keyset.
 */
export class GithubOidcAdapter implements OidcPort {
  readonly issuer: string;
  readonly keys: ReturnType<typeof createRemoteJWKSet>;
  private readonly jwksUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: WitnessConfig, fetchImpl: typeof fetch = fetch) {
    this.issuer = config.KLAXON_OIDC_ISSUER;
    this.jwksUrl = config.KLAXON_OIDC_JWKS_URL;
    this.fetchImpl = fetchImpl;
    this.keys = createRemoteJWKSet(new URL(this.jwksUrl), {
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
  }

  async fetchJwks(): Promise<{ keys: unknown[] }> {
    const res = await this.fetchImpl(this.jwksUrl, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`JWKS fetch returned ${res.status}`);
    const body = (await res.json()) as { keys?: unknown[] };
    if (!Array.isArray(body.keys)) throw new Error("JWKS document has no keys array");
    return { keys: body.keys };
  }
}
