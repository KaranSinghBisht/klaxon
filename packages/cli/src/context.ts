import type { KlaxonMember } from "@klaxon/core";
import {
  type KlaxonConfig,
  loadConfig,
  type ProjectConfig,
  resolveProject,
  saveConfig,
} from "./config/config-store.js";
import { configPath, operatorKeyPath, stateDir } from "./config/paths.js";
import type { CliDeps } from "./deps.js";
import { CliError } from "./errors.js";
import { loadMember } from "./member.js";
import { loadOperatorKey } from "./operator.js";
import { WitnessClient } from "./witness-client.js";

export interface ProjectContext {
  configFile: string;
  config: KlaxonConfig;
  name: string;
  project: ProjectConfig;
  stateDir: string;
}

export function loadProjectContext(deps: CliDeps, projectName?: string): ProjectContext {
  const configFile = configPath(deps.env, deps.home);
  const config = loadConfig(configFile);
  const { name, project } = resolveProject(config, projectName);
  return { configFile, config, name, project, stateDir: stateDir(deps.env, deps.home) };
}

/** Loads the member credential the same way every laptop-side command does: keychain + session. */
export async function contextMember(deps: CliDeps, ctx: ProjectContext): Promise<KlaxonMember> {
  const { member } = await loadMember({
    stateDir: ctx.stateDir,
    keychain: deps.keychain,
    env: deps.env,
  });
  return member;
}

export function witnessFor(deps: CliDeps, project: ProjectConfig): WitnessClient {
  const operator = loadOperatorKey(operatorKeyPath(deps.env, deps.home));
  if (operator.pubkey !== project.operator_pubkey) {
    throw new CliError(
      "OPERATOR_KEY_MISMATCH",
      `~/.klaxon/operator.key does not match the key registered for this project (${project.operator_pubkey})`,
    );
  }
  return new WitnessClient({
    baseUrl: project.witness_url,
    operator,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });
}

export function persistProject(ctx: ProjectContext, next: ProjectConfig): void {
  saveConfig(ctx.configFile, {
    ...ctx.config,
    projects: { ...ctx.config.projects, [ctx.name]: next },
  });
}
