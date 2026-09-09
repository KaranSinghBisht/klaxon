import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { CliError } from "../errors.js";

/**
 * `~/.klaxon/config.json` (A §4.4). It holds public coordinates only: never the member private
 * key (that stays in the OS keychain) and never `WITNESS_MASTER` (paper, plus an optional
 * `~/.klaxon/witness-master.key` when the operator self-hosts).
 */
export const ProjectConfigSchema = z.object({
  project_id: z.string().regex(/^[0-9a-f]{64}$/),
  repository: z.string().min(1),
  repository_id: z.string().regex(/^[0-9]+$/),
  trustchain_root_id: z.string().min(1),
  application_path: z.string().min(1),
  application_id: z.literal(17).default(17),
  witness_url: z.string().url(),
  topic_id: z.string().min(1),
  registry_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chain_id: z.number().int().positive().default(11155111),
  hedera_account: z.string().min(1),
  hedera_network: z.string().min(1).default("testnet"),
  member_pubkey: z.string().regex(/^0[23][0-9a-f]{64}$/),
  /** Public half of `~/.klaxon/operator.key`; the private half is never written here. */
  operator_pubkey: z.string().regex(/^0[23][0-9a-f]{64}$/),
  /** Hedera account the runner pays from; the witness binds check 1's debit to it. */
  pay_account: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional(),
  ntfy_topic: z.string().min(1).optional(),
  account_label: z.string().min(1).optional(),
  /** Highest revocation epoch this laptop has seen; `unrevoke` submits this + 1 (monotonic, §8). */
  last_epoch: z.number().int().nonnegative().default(0),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  default_project: z.string().min(1).optional(),
  projects: z.record(z.string().min(1), ProjectConfigSchema).default({}),
});
export type KlaxonConfig = z.infer<typeof ConfigSchema>;

export function emptyConfig(): KlaxonConfig {
  return { version: 1, projects: {} };
}

export function parseConfig(text: string): KlaxonConfig {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new CliError("CONFIG_MALFORMED", "~/.klaxon/config.json is not valid JSON", { cause });
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      "CONFIG_MALFORMED",
      `config.json failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}

export function loadConfig(file: string): KlaxonConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return emptyConfig();
  }
  return parseConfig(text);
}

/** 0600: the file names the witness and the topic, which is enough to be worth not sharing. */
export function saveConfig(file: string, cfg: KlaxonConfig): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

export function resolveProject(
  cfg: KlaxonConfig,
  name?: string,
): { name: string; project: ProjectConfig } {
  const key = name ?? cfg.default_project;
  if (!key) {
    throw new CliError(
      "PROJECT_UNKNOWN",
      "no project selected and no default_project in ~/.klaxon/config.json — run `klaxon init` or pass --project",
    );
  }
  const project = cfg.projects[key];
  if (!project) {
    throw new CliError("PROJECT_UNKNOWN", `no project named ${key} in ~/.klaxon/config.json`);
  }
  return { name: key, project };
}

export function upsertProject(
  cfg: KlaxonConfig,
  name: string,
  project: ProjectConfig,
): KlaxonConfig {
  return {
    version: 1,
    default_project: cfg.default_project ?? name,
    projects: { ...cfg.projects, [name]: project },
  };
}
