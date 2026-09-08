import { execFile } from "node:child_process";
import { CliError } from "../errors.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
}

/** Runs the `wallet-cli` binary. Injected everywhere so tests never reach a real device. */
export type WalletCliRunner = (args: string[], opts: RunOptions) => Promise<RunResult>;

export const DEFAULT_BIN = "wallet-cli";
/** D19: raise the device prompt window from the 60 s default so filming does not time out. */
export const DEVICE_TIMEOUT_MS = 180_000;

/** `execFile` with an args array — never a shell, so a project name can never become a command. */
export function execFileRunner(bin: string = DEFAULT_BIN): WalletCliRunner {
  return (args, opts) =>
    new Promise((resolvePromise) => {
      execFile(
        bin,
        args,
        { timeout: opts.timeoutMs ?? DEVICE_TIMEOUT_MS + 30_000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? ((err as { code: number }).code as number)
              : err
                ? 1
                : 0;
          resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

export type EnvelopeShape = "ok-data" | "status" | "bare";

export interface WalletCliEnvelope {
  ok: boolean;
  /** The payload, normalised across envelope shapes. */
  data: unknown;
  error: string | undefined;
  shape: EnvelopeShape;
}

/**
 * D15 is unresolved: appendix A saw `{status:"success", ...}` in the binary and appendix B saw
 * `{ok:true, data:{...}}`. Neither can be settled without the device, so both are accepted and
 * normalised to one result. A bare JSON object with no envelope marker is treated as the payload.
 *
 * TODO(day1): pin to captured real output — capture one real `wallet-cli send --output json`
 * response with the device attached and narrow this to the shape it actually emits.
 */
export function parseWalletCliEnvelope(stdout: string): WalletCliEnvelope {
  const text = stdout.trim();
  if (!text) throw new CliError("WALLET_CLI_UNPARSEABLE", "wallet-cli produced no output");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    throw new CliError("WALLET_CLI_UNPARSEABLE", "wallet-cli --output json emitted non-JSON", {
      cause,
    });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: true, data: payload, error: undefined, shape: "bare" };
  }
  const obj = payload as Record<string, unknown>;

  if (typeof obj.ok === "boolean") {
    const ok = obj.ok;
    return {
      ok,
      data: "data" in obj ? obj.data : obj,
      error: ok ? undefined : envelopeError(obj),
      shape: "ok-data",
    };
  }
  if (typeof obj.status === "string") {
    const ok = obj.status === "success" || obj.status === "ok";
    const { status: _status, ...rest } = obj;
    return {
      ok,
      data: "data" in obj ? obj.data : rest,
      error: ok ? undefined : envelopeError(obj),
      shape: "status",
    };
  }
  return { ok: true, data: obj, error: undefined, shape: "bare" };
}

function envelopeError(obj: Record<string, unknown>): string {
  for (const key of ["error", "message", "reason", "status"]) {
    const v = obj[key];
    if (typeof v === "string" && v) return v;
    if (v && typeof v === "object") {
      const nested = (v as Record<string, unknown>).message;
      if (typeof nested === "string" && nested) return nested;
    }
  }
  return "wallet-cli reported failure";
}

/**
 * stdout is never surfaced: `ring init` and friends can print key material, and this error text
 * ends up in terminals, CI logs and screen recordings. stderr is progress/diagnostics only.
 */
function redactedStdout(stdout: string): string {
  return `<redacted ${Buffer.byteLength(stdout, "utf8")} bytes of wallet-cli stdout>`;
}

export interface WalletCliOptions {
  runner: WalletCliRunner;
  deviceTimeoutMs?: number;
}

export class WalletCli {
  private readonly runner: WalletCliRunner;
  readonly deviceTimeoutMs: number;

  constructor(o: WalletCliOptions) {
    this.runner = o.runner;
    this.deviceTimeoutMs = o.deviceTimeoutMs ?? DEVICE_TIMEOUT_MS;
  }

  /** Always `--output json`; a non-zero exit or a failed envelope raises with stdout redacted. */
  async run(args: string[], opts: RunOptions = {}): Promise<unknown> {
    const argv = args.includes("--output") ? args : [...args, "--output", "json"];
    const res = await this.runner(argv, opts);
    if (res.code !== 0) {
      throw new CliError(
        "WALLET_CLI_FAILED",
        `wallet-cli ${argv[0] ?? ""} ${argv[1] ?? ""} exited ${res.code}`.trim(),
        { detail: `${res.stderr.trim()}\n${redactedStdout(res.stdout)}`.trim() },
      );
    }
    const env = parseWalletCliEnvelope(res.stdout);
    if (!env.ok) {
      throw new CliError(
        "WALLET_CLI_FAILED",
        `wallet-cli ${argv[0] ?? ""} ${argv[1] ?? ""} failed: ${env.error}`.trim(),
        { detail: `${res.stderr.trim()}\n${redactedStdout(res.stdout)}`.trim() },
      );
    }
    return env.data;
  }

  ringInit(): Promise<unknown> {
    return this.run(["ring", "init"], { timeoutMs: this.deviceTimeoutMs });
  }

  accountDiscover(network: string): Promise<unknown> {
    return this.run(["account", "discover", "--network", network], {
      timeoutMs: this.deviceTimeoutMs,
    });
  }

  /** The device moment: `commitPolicy` / `register` / `unrevoke` calldata to the registry. */
  send(a: {
    account: string;
    to: string;
    data: string;
    amount?: string;
    dryRun?: boolean;
  }): Promise<unknown> {
    const args = [
      "send",
      "--account",
      a.account,
      "--to",
      a.to,
      "--amount",
      a.amount ?? "0 ETH",
      "--data",
      a.data,
      "--output",
      "json",
      "--device-timeout",
      String(this.deviceTimeoutMs),
    ];
    // `--dry-run` prepares and validates without asking the device — the rehearsal path (D19).
    if (a.dryRun) args.push("--dry-run");
    return this.run(args, { timeoutMs: this.deviceTimeoutMs });
  }
}

/**
 * `account discover --output json` saves a session label. D15 leaves the exact string open
 * (`ethereum-sepolia-1` vs `ethereum_sepolia-1`), so the label is read out of the JSON rather
 * than hardcoded: take the first `label` string anywhere in the payload, preferring one whose
 * text shares a stem with the requested network.
 */
export function extractAccountLabel(data: unknown, network: string): string {
  const labels = collectStrings(data, "label");
  if (labels.length === 0) {
    throw new CliError(
      "WALLET_CLI_UNPARSEABLE",
      `wallet-cli account discover returned no account label for ${network}`,
    );
  }
  const stem = network.split(/[:_-]/)[0]?.toLowerCase() ?? "";
  const preferred = labels.find((l) => stem !== "" && l.toLowerCase().includes(stem));
  return preferred ?? (labels[0] as string);
}

const TX_HASH_KEYS = ["txHash", "transactionHash", "hash", "tx", "transaction", "txid"];

/**
 * TODO(day1): pin to captured real output — the shape of `data.*` for `send` is the one
 * wallet-cli response nobody can see without hardware, so any 0x-64-hex under a plausible key wins.
 */
export function extractTxHash(data: unknown): string | undefined {
  for (const key of TX_HASH_KEYS) {
    const hit = collectStrings(data, key).find((v) => /^0x[0-9a-fA-F]{64}$/.test(v));
    if (hit) return hit;
  }
  return undefined;
}

function collectStrings(value: unknown, key: string, depth = 0): string[] {
  if (depth > 8 || value === null || typeof value !== "object") return [];
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) out.push(...collectStrings(item, key, depth + 1));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === key && typeof v === "string" && v) out.push(v);
    else if (v && typeof v === "object") out.push(...collectStrings(v, key, depth + 1));
  }
  return out;
}
