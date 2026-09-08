import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import {
  extractAccountLabel,
  extractTxHash,
  parseWalletCliEnvelope,
  WalletCli,
  type WalletCliRunner,
} from "../src/wallet-cli/exec.js";

const SECRET_IN_STDOUT = `{"ok":false,"error":"user rejected","key":"${"de".repeat(32)}"}`;

function runner(res: { code?: number; stdout?: string; stderr?: string }): {
  impl: WalletCliRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const impl: WalletCliRunner = async (args) => {
    calls.push(args);
    return { code: res.code ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  };
  return { impl, calls };
}

describe("parseWalletCliEnvelope", () => {
  it("normalises the {ok:true,data} shape appendix B saw", () => {
    const env = parseWalletCliEnvelope('{"ok":true,"data":{"txHash":"0x1"}}');
    expect(env).toMatchObject({ ok: true, shape: "ok-data", data: { txHash: "0x1" } });
  });

  it("normalises the {status:'success'} shape appendix A saw", () => {
    const env = parseWalletCliEnvelope('{"status":"success","txHash":"0x1"}');
    expect(env.ok).toBe(true);
    expect(env.shape).toBe("status");
    expect(env.data).toEqual({ txHash: "0x1" });
  });

  it("prefers an explicit data field even in the status shape", () => {
    const env = parseWalletCliEnvelope('{"status":"success","data":{"txHash":"0x2"}}');
    expect(env.data).toEqual({ txHash: "0x2" });
  });

  it("treats an unmarked object as the payload", () => {
    const env = parseWalletCliEnvelope('{"accounts":[{"label":"ethereum_sepolia-1"}]}');
    expect(env.ok).toBe(true);
    expect(env.shape).toBe("bare");
  });

  it("reports failure in both shapes and finds the message", () => {
    expect(parseWalletCliEnvelope('{"ok":false,"error":"denied"}')).toMatchObject({
      ok: false,
      error: "denied",
    });
    expect(parseWalletCliEnvelope('{"status":"error","message":"timeout"}')).toMatchObject({
      ok: false,
      error: "timeout",
    });
  });

  it("raises on empty or non-JSON output", () => {
    expect(() => parseWalletCliEnvelope("   ")).toThrowError(CliError);
    expect(() => parseWalletCliEnvelope("not json")).toThrowError(/non-JSON/);
  });
});

describe("WalletCli.run", () => {
  it("always adds --output json", async () => {
    const { impl, calls } = runner({ stdout: '{"ok":true,"data":{}}' });
    await new WalletCli({ runner: impl }).run(["ring", "init"]);
    expect(calls[0]).toEqual(["ring", "init", "--output", "json"]);
  });

  it("keeps stdout out of the error on a non-zero exit", async () => {
    const { impl } = runner({ code: 3, stdout: SECRET_IN_STDOUT, stderr: "device timeout" });
    const err = await new WalletCli({ runner: impl })
      .run(["send"])
      .catch((e: unknown) => e as CliError);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("WALLET_CLI_FAILED");
    expect((err as CliError).detail).toContain("device timeout");
    expect((err as CliError).detail).toContain("<redacted");
    expect(JSON.stringify(err)).not.toContain("de".repeat(32));
    expect((err as CliError).detail).not.toContain("de".repeat(32));
  });

  it("keeps stdout out of the error when the envelope reports failure", async () => {
    const { impl } = runner({ code: 0, stdout: SECRET_IN_STDOUT, stderr: "" });
    const err = await new WalletCli({ runner: impl })
      .run(["send"])
      .catch((e: unknown) => e as CliError);
    expect((err as CliError).message).toContain("user rejected");
    expect((err as CliError).detail).toMatch(/^<redacted \d+ bytes of wallet-cli stdout>$/);
  });

  it("builds the send invocation the plan specifies, including the filming timeout", async () => {
    const { impl, calls } = runner({ stdout: '{"ok":true,"data":{"txHash":"0x0"}}' });
    await new WalletCli({ runner: impl, deviceTimeoutMs: 180_000 }).send({
      account: "ethereum_sepolia-1",
      to: "0xabc",
      data: "0xdeadbeef",
    });
    expect(calls[0]).toEqual([
      "send",
      "--account",
      "ethereum_sepolia-1",
      "--to",
      "0xabc",
      "--amount",
      "0 ETH",
      "--data",
      "0xdeadbeef",
      "--output",
      "json",
      "--device-timeout",
      "180000",
    ]);
  });

  it("appends --dry-run when rehearsing", async () => {
    const { impl, calls } = runner({ stdout: '{"ok":true,"data":{}}' });
    await new WalletCli({ runner: impl }).send({
      account: "a",
      to: "0xabc",
      data: "0x00",
      dryRun: true,
    });
    expect(calls[0]?.at(-1)).toBe("--dry-run");
  });
});

describe("payload extraction", () => {
  it("reads the account label out of the JSON rather than hardcoding it (D15)", () => {
    const underscored = { accounts: [{ label: "ethereum_sepolia-1" }] };
    const dashed = { data: { accounts: [{ label: "ethereum-sepolia-1" }] } };
    expect(extractAccountLabel(underscored, "ethereum:sepolia")).toBe("ethereum_sepolia-1");
    expect(extractAccountLabel(dashed, "ethereum:sepolia")).toBe("ethereum-sepolia-1");
  });

  it("prefers a label that shares a stem with the requested network", () => {
    const data = { accounts: [{ label: "solana-1" }, { label: "ethereum_sepolia-1" }] };
    expect(extractAccountLabel(data, "ethereum:sepolia")).toBe("ethereum_sepolia-1");
  });

  it("raises when discovery returned no label at all", () => {
    expect(() => extractAccountLabel({ accounts: [] }, "ethereum:sepolia")).toThrowError(CliError);
  });

  it("finds a transaction hash under any of the plausible keys", () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(extractTxHash({ txHash: hash })).toBe(hash);
    expect(extractTxHash({ result: { transactionHash: hash } })).toBe(hash);
    expect(extractTxHash({ nothing: "here" })).toBeUndefined();
    expect(extractTxHash({ hash: "0xshort" })).toBeUndefined();
  });
});
