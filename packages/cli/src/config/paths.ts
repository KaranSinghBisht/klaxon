import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const KEYCHAIN_SERVICE = "ledger-wallet-cli";
export const SESSION_FILE = "session.yaml";

/**
 * wallet-cli's own state-directory resolution, reimplemented (A §3.1) rather than imported:
 * `$XDG_STATE_HOME/ledger-wallet-cli`, else `~/.local/state/ledger-wallet-cli`.
 *
 * The keychain account name hashes this string, so it must match wallet-cli byte for byte.
 * wallet-cli uses `path.join`, which leaves a relative `XDG_STATE_HOME` relative; we resolve to
 * an absolute path because that is what the operator's shell always produces in practice and it
 * makes the hash independent of the cwd `klaxon` happens to run in.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_STATE_HOME?.trim();
  const base = xdg ? xdg : join(home, ".local", "state");
  const joined = join(base, KEYCHAIN_SERVICE);
  return isAbsolute(joined) ? joined : resolve(joined);
}

/** `member-private-key-<sha256(stateDir)[:16]>` — the account half of the keychain entry (A §3.1). */
export function keychainAccount(dir: string): string {
  return `member-private-key-${createHash("sha256").update(dir, "utf8").digest("hex").slice(0, 16)}`;
}

export function sessionPath(dir: string): string {
  return join(dir, SESSION_FILE);
}

/** `~/.klaxon`, overridable with `KLAXON_HOME` so tests never touch the operator's real config. */
export function klaxonHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.KLAXON_HOME?.trim();
  return override ? resolve(override) : join(home, ".klaxon");
}

export function configPath(env?: NodeJS.ProcessEnv, home?: string): string {
  return join(klaxonHome(env, home), "config.json");
}

/** Written only when the operator self-hosts the witness; mode 0600, never in the repo (A §4.4). */
export function witnessMasterPath(env?: NodeJS.ProcessEnv, home?: string): string {
  return join(klaxonHome(env, home), "witness-master.key");
}

export function encDir(cwd: string): string {
  return join(cwd, ".klaxon");
}

export function encFilePath(cwd: string, secret: string): string {
  return join(encDir(cwd), `${secret}.enc`);
}

export function policyPath(cwd: string): string {
  return join(cwd, "klaxon.policy.json");
}
