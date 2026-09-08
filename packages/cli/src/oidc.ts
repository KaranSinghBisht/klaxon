import type { OidcProvider } from "@klaxon/core";
import { CliError } from "./errors.js";

interface TokenResponse {
  value?: unknown;
}

/**
 * GitHub's OIDC endpoint, the same one `@actions/core`'s `getIDToken` calls. `klaxon get` only
 * ever runs on a runner, so the two request variables are always present there; off a runner the
 * error says so rather than producing an unusable token.
 */
export function githubOidc(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): OidcProvider {
  return async (audience: string) => {
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !token) {
      throw new CliError(
        "BAD_ARGUMENT",
        "no GitHub OIDC endpoint in the environment — `klaxon get` runs on a runner with `permissions: id-token: write`",
      );
    }
    const res = await fetchImpl(`${url}&audience=${encodeURIComponent(audience)}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!res.ok) {
      throw new CliError("BAD_ARGUMENT", `OIDC token request returned ${res.status}`);
    }
    const body = (await res.json()) as TokenResponse;
    if (typeof body.value !== "string" || !body.value) {
      throw new CliError("BAD_ARGUMENT", "OIDC token response carried no value");
    }
    return body.value;
  };
}
