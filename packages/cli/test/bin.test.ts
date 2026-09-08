import { describe, expect, it } from "vitest";
import { buildProgram, formatError, main } from "../src/bin.js";
import { CliError } from "../src/errors.js";
import { makeHarness } from "./helpers.js";

const COMMANDS = [
  "init",
  "export-member",
  "policy",
  "add",
  "get",
  "rotate",
  "revoke",
  "unrevoke",
  "emergency",
];

describe("commander wiring", () => {
  it("registers every command in the map", () => {
    const program = buildProgram(makeHarness().deps);
    expect(program.commands.map((c) => c.name())).toEqual(COMMANDS);
  });

  it("nests `policy commit` under `policy`", () => {
    const policy = buildProgram(makeHarness().deps).commands.find((c) => c.name() === "policy");
    expect(policy?.commands.map((c) => c.name())).toEqual(["commit"]);
  });

  it("declares the arguments and options each command needs", () => {
    const program = buildProgram(makeHarness().deps);
    const byName = (n: string) => program.commands.find((c) => c.name() === n);
    expect(byName("add")?.registeredArguments.map((a) => a.name())).toEqual(["NAME"]);
    expect(byName("get")?.options.map((o) => o.long)).toContain("--i-know-what-im-doing");
    expect(byName("get")?.options.map((o) => o.long)).toContain("--transport");
    expect(byName("emergency")?.options.map((o) => o.long)).toContain("--pay-account");
    expect(byName("export-member")?.options.map((o) => o.long)).toContain("--wrap");
    expect(
      byName("init")
        ?.options.filter((o) => o.mandatory)
        .map((o) => o.long),
    ).toEqual(["--repository", "--repository-id", "--witness", "--registry"]);
  });

  it("routes help to the injected stdout rather than the process", async () => {
    const h = makeHarness();
    expect(await main(["--help"], h.deps)).toBe(0);
    for (const name of COMMANDS) expect(h.stdout()).toContain(name);
  });

  it("prints the version", async () => {
    const h = makeHarness();
    expect(await main(["--version"], h.deps)).toBe(0);
    expect(h.stdout().trim()).toBe("0.1.0");
  });

  it("returns a non-zero code for an unknown command without exiting the process", async () => {
    const h = makeHarness();
    expect(await main(["not-a-command"], h.deps)).toBe(1);
    expect(h.stderr()).toContain("unknown command");
  });

  it("returns a non-zero code and a coded message when a command throws", async () => {
    const h = makeHarness({ isTty: () => true });
    expect(await main(["get", "SOME_SECRET"], h.deps)).toBe(1);
    expect(h.stderr()).toContain("[TTY_REFUSED]");
  });

  it("explains that the payment transport lives in the action", async () => {
    const h = makeHarness();
    expect(await main(["get", "SOME_SECRET"], h.deps)).toBe(1);
    expect(h.stderr()).toContain("[NO_TRANSPORT]");
    expect(h.stderr()).toContain("packages/action");
  });
});

describe("formatError", () => {
  it("prints the code and the operator-safe detail", () => {
    const text = formatError(new CliError("WALLET_CLI_FAILED", "boom", { detail: "stderr line" }));
    expect(text).toContain("[WALLET_CLI_FAILED]");
    expect(text).toContain("stderr line");
  });

  it("falls back gracefully for anything else", () => {
    expect(formatError(new Error("plain"))).toBe("error: plain\n");
    expect(formatError("string")).toBe("error: string\n");
  });
});
