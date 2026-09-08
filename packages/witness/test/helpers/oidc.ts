import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import type { OidcPort } from "../../src/ports/index.js";

/**
 * A §7.2 — a fake GitHub OIDC issuer. A local RS256 keypair behind `createLocalJWKSet`, injected
 * into check 2 through `OidcPort`, which is what lets these tests mint tokens with *hostile*
 * claim sets: no `environment`, a mismatched `run_id`, a foreign `repository_id`. Without this the
 * A §0.5 attack could not be tested at all.
 */
export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

export interface FakeIssuer extends OidcPort {
  /** `issuedAt` follows the harness clock so a frozen "now" does not expire every token. */
  mint(claims: Record<string, unknown>, audience: string, issuedAt?: Date): Promise<string>;
  /** Signs with a second, unadvertised key — a token that must fail signature verification. */
  mintWithForeignKey(
    claims: Record<string, unknown>,
    audience: string,
    issuedAt?: Date,
  ): Promise<string>;
  jwks: { keys: JWK[] };
}

export async function createFakeIssuer(issuer: string = GITHUB_ISSUER): Promise<FakeIssuer> {
  const good = await generateKeyPair("RS256", { extractable: true });
  const foreign = await generateKeyPair("RS256", { extractable: true });
  const jwk = {
    ...(await exportJWK(good.publicKey)),
    kid: "klaxon-test-1",
    alg: "RS256",
    use: "sig",
  };
  const jwks = { keys: [jwk] };
  const keys = createLocalJWKSet(jwks);

  type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  const sign = async (
    key: SigningKey,
    kid: string,
    claims: Record<string, unknown>,
    audience: string,
    issuedAt: Date,
  ): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(new Date(issuedAt.getTime() + 600_000))
      .sign(key);

  return {
    issuer,
    keys,
    jwks,
    async fetchJwks() {
      return { keys: jwks.keys };
    },
    mint: (claims, audience, issuedAt = new Date()) =>
      sign(good.privateKey, "klaxon-test-1", claims, audience, issuedAt),
    mintWithForeignKey: (claims, audience, issuedAt = new Date()) =>
      sign(foreign.privateKey, "klaxon-test-1", claims, audience, issuedAt),
  };
}
