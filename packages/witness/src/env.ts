import { z } from "zod";

/**
 * Every knob the witness has, read from `process.env` and validated once at boot (B §9: nothing is
 * hardcoded, absence throws). `main.ts` calls `loadEnv()`; `server.ts` takes the result, so tests
 * build a config object directly and never touch the process environment.
 */

const HEX64 = /^[0-9a-f]{64}$/i;

/** 32 bytes as 64 hex chars or base64/base64url — the Fly secret is hex (B §9), A §5.10 wrote base64. */
const MasterSchema = z
  .string()
  .min(32)
  .transform((s, ctx) => {
    const buf = HEX64.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
    if (buf.length !== 32) {
      ctx.addIssue({ code: "custom", message: "WITNESS_MASTER must decode to exactly 32 bytes" });
      return z.NEVER;
    }
    return buf;
  });

const intFrom = (fallback: number) =>
  z.coerce.number().int().nonnegative().default(fallback) as z.ZodType<number, unknown>;

const boolFrom = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .default(fallback ? "true" : "false")
    .transform((v) => v === "true" || v === "1");

export const EnvSchema = z.object({
  // --- process ---
  KLAXON_DB_PATH: z.string().min(1).default("/data/klaxon.db"),
  KLAXON_HOST: z.string().min(1).default("0.0.0.0"),
  PORT: intFrom(8080),
  KLAXON_PUBLIC_URL: z.url(),
  KLAXON_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // --- share B (D28: derived, never stored) ---
  WITNESS_MASTER: MasterSchema,

  // --- Hedera ---
  HEDERA_NETWORK: z.enum(["testnet", "mainnet", "previewnet"]).default("testnet"),
  HEDERA_OPERATOR_ID: z.string().regex(/^\d+\.\d+\.\d+$/),
  HEDERA_OPERATOR_KEY: z.string().min(1),
  HEDERA_KEY_TYPE: z.enum(["ecdsa", "ed25519", "der"]).default("ecdsa"),
  KLAXON_WITNESS_ACCOUNT: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional(),
  MIRROR_NODE: z.url().default("https://testnet.mirrornode.hedera.com"),

  // --- x402 (B §2.2) ---
  X402_FACILITATOR: z.url().default("https://api.testnet.blocky402.com"),
  X402_NETWORK: z
    .string()
    .regex(/^[^:]+:[^:]+$/)
    .default("hedera:testnet"),
  X402_ASSET: z.string().min(1).default("0.0.0"),
  X402_PRICE_TINYBAR: z
    .string()
    .regex(/^[0-9]+$/)
    .default("100000"),
  X402_MAX_TIMEOUT_S: intFrom(120),

  // --- Sepolia registry (D8, D14) ---
  SEPOLIA_RPC_URL: z.url().default("https://ethereum-sepolia-rpc.publicnode.com"),
  KLAXON_REGISTRY: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  KLAXON_REGISTRY_DEPLOY_BLOCK: intFrom(0),
  CONFIRMATIONS: intFrom(3),
  KLAXON_REGISTRY_POLL_MS: intFrom(15_000),

  // --- source of policy + workflows (D7) ---
  KLAXON_SOURCE: z.enum(["raw", "api"]).default("raw"),
  GITHUB_TOKEN: z.string().optional(),

  // --- OIDC ---
  KLAXON_OIDC_ISSUER: z.url().default("https://token.actions.githubusercontent.com"),
  KLAXON_OIDC_JWKS_URL: z
    .url()
    .default("https://token.actions.githubusercontent.com/.well-known/jwks"),

  // --- alarm (D29) ---
  NTFY_BASE: z.url().default("https://ntfy.sh"),
  NTFY_DEFAULT_TOPIC: z.string().optional(),
  /** The release notice, at a lower priority than a refusal. On by default; a deploy is news. */
  KLAXON_ALARM_ON_RELEASE: boolFrom(true),

  // --- policy knobs (D16, D22) ---
  KLAXON_PAYMENT_MAX_AGE_S: intFrom(600),
  KLAXON_CLOCK_TOLERANCE_S: intFrom(60),
  KLAXON_REVOKE_ON_BUDGET: boolFrom(false),
  KLAXON_MAX_RELEASES_DEFAULT: intFrom(50),

  // --- background jobs ---
  KLAXON_OUTBOX_POLL_MS: intFrom(5_000),
  KLAXON_JWKS_SNAPSHOT_MS: intFrom(86_400_000),
});

export type WitnessEnv = z.infer<typeof EnvSchema>;

/** Config the server actually consumes: the parsed env plus the resolved payee account. */
export interface WitnessConfig extends WitnessEnv {
  witnessAccount: string;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WitnessConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid witness configuration — ${detail}`);
  }
  return {
    ...parsed.data,
    // The witness's HCS operator is also the payee unless deliberately split.
    witnessAccount: parsed.data.KLAXON_WITNESS_ACCOUNT ?? parsed.data.HEDERA_OPERATOR_ID,
  };
}
