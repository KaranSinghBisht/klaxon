import type { Hex } from "viem";
import type { ProjectConfig } from "../config/config-store.js";
import { type ProjectContext, persistProject } from "../context.js";
import type { CliDeps } from "../deps.js";
import {
  DEVICE_TIMEOUT_MS,
  extractAccountLabel,
  extractTxHash,
  WalletCli,
} from "../wallet-cli/exec.js";

export const DEFAULT_EVM_NETWORK = "ethereum:sepolia";

export interface DeviceSessionOptions {
  network?: string;
  dryRun?: boolean;
  deviceTimeoutMs?: number;
}

export interface SentCall {
  label: string;
  data: Hex;
  txHash: string | undefined;
  raw: unknown;
}

export function walletCliFor(deps: CliDeps, opts: DeviceSessionOptions): WalletCli {
  return new WalletCli({
    runner: deps.runWalletCli,
    deviceTimeoutMs: opts.deviceTimeoutMs ?? DEVICE_TIMEOUT_MS,
  });
}

/**
 * D15: the session label wallet-cli saves for Sepolia is `ethereum-sepolia-1` in one appendix and
 * `ethereum_sepolia-1` in the other, and only a device can settle it — so it is discovered once,
 * read out of the JSON, and cached in `~/.klaxon/config.json`. Nothing here hardcodes it.
 */
export async function resolveAccountLabel(
  deps: CliDeps,
  ctx: ProjectContext,
  opts: DeviceSessionOptions,
): Promise<string> {
  if (ctx.project.account_label) return ctx.project.account_label;
  const network = opts.network ?? DEFAULT_EVM_NETWORK;
  const data = await walletCliFor(deps, opts).accountDiscover(network);
  const label = extractAccountLabel(data, network);
  const next: ProjectConfig = { ...ctx.project, account_label: label };
  persistProject(ctx, next);
  ctx.project = next;
  deps.stderr(`wallet-cli account label for ${network}: ${label}\n`);
  return label;
}

/**
 * D19: several calls in one device session — `register` then the first `commitPolicy` at `init`
 * is two approvals, back to back, one trip to wherever the Ledger lives.
 */
export async function sendCalls(
  deps: CliDeps,
  ctx: ProjectContext,
  calls: Array<{ data: Hex; note: string }>,
  opts: DeviceSessionOptions,
): Promise<SentCall[]> {
  const label = await resolveAccountLabel(deps, ctx, opts);
  const wallet = walletCliFor(deps, opts);
  const out: SentCall[] = [];
  for (const call of calls) {
    deps.stderr(
      `${opts.dryRun ? "[dry-run] " : ""}${call.note} -> ${ctx.project.registry_address}\n`,
    );
    const raw = await wallet.send({
      account: label,
      to: ctx.project.registry_address,
      data: call.data,
      ...(opts.dryRun ? { dryRun: true } : {}),
    });
    const txHash = extractTxHash(raw);
    out.push({ label, data: call.data, txHash, raw });
    deps.stdout(`${call.note} ${txHash ?? "(no tx hash in wallet-cli output)"}\n`);
  }
  return out;
}
