import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { sessionPath } from "../config/paths.js";
import { CliError } from "../errors.js";

/**
 * `session.yaml` as wallet-cli 2.1.0 persists it (A §3.4). Unknown keys are dropped rather than
 * rejected — wallet-cli owns this file and may grow fields we have no business validating.
 *
 * It never contains `walletSyncEncryptionKey`: wallet-cli strips it before writing, which is why
 * every release has to call `restoreTrustchain` again.
 */
export const SessionSchema = z.object({
  accounts: z.array(z.object({ label: z.string(), descriptor: z.string().optional() })).default([]),
  trustchain: z
    .object({ rootId: z.string().min(1), applicationPath: z.string().min(1) })
    .optional(),
  domains: z.array(z.object({ domain: z.string(), firstUsed: z.string().optional() })).default([]),
  passwordSalt: z
    .string()
    .regex(/^[0-9a-f]{32}$/, "passwordSalt must be 32 lowercase hex characters")
    .optional(),
});
export type WalletSession = z.infer<typeof SessionSchema>;

export function parseSession(text: string): WalletSession {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (cause) {
    throw new CliError("SESSION_MALFORMED", "session.yaml is not valid YAML", { cause });
  }
  const parsed = SessionSchema.safeParse(doc ?? {});
  if (!parsed.success) {
    throw new CliError(
      "SESSION_MALFORMED",
      `session.yaml failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}

export function readSession(dir: string): WalletSession {
  const file = sessionPath(dir);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    throw new CliError(
      "SESSION_MISSING",
      `no wallet-cli session at ${file} — run \`wallet-cli ring init\` first`,
      { cause },
    );
  }
  return parseSession(text);
}

/** The trustchain block is optional in the file but mandatory for everything KLAXON does. */
export function requireTrustchain(s: WalletSession): { rootId: string; applicationPath: string } {
  if (!s.trustchain) {
    throw new CliError(
      "SESSION_MALFORMED",
      "session.yaml has no trustchain — run `wallet-cli ring init` with the device attached",
    );
  }
  return s.trustchain;
}
