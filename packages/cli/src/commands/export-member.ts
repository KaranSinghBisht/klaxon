import { encodeMember } from "@klaxon/core";
import { Command } from "commander";
import { stateDir } from "../config/paths.js";
import type { CliDeps } from "../deps.js";
import { CliError } from "../errors.js";
import { loadMember } from "../member.js";
import { wrapEncLine } from "../wallet-cli/keychain.js";

export interface ExportMemberOptions {
  wrap?: boolean;
  out?: string;
}

/**
 * The `--wrap` envelope (A §3.6). It is deliberately NOT a `KlaxonMember`: core's schema demands
 * a bare 64-hex `privatekey`, so a wrapped credential is a different artifact that needs
 * `WALLET_PASS` on the consumer side before `decodeMember` will look at it.
 */
export interface WrappedMember {
  v: 1;
  wrapped: true;
  rootId: string;
  applicationPath: string;
  applicationId: 17;
  privatekey: string;
  pubkey: string;
  passwordSalt: string;
}

/**
 * Emits the `KLAXON_MEMBER` GitHub secret as one base64 line, once, to stdout. Nothing is
 * written to disk: if the operator wants it in a file they redirect it themselves.
 *
 * D3 makes plaintext the default, overriding A §3.6. The threat model already concedes the
 * member credential to the in-scope attacker (anyone who can read the runner's secrets), so a
 * second secret in the same environment buys nothing — it only adds a way for the release to
 * fail at 3 a.m. `--wrap` remains available for the two-secrets posture and is documented as
 * not consumable by the shipped action.
 */
export async function runExportMember(deps: CliDeps, opts: ExportMemberOptions): Promise<void> {
  if (opts.out !== undefined && opts.out !== "-") {
    throw new CliError(
      "BAD_ARGUMENT",
      "--out only accepts `-` (stdout); redirect stdout yourself if this has to land in a file",
    );
  }
  const dir = stateDir(deps.env, deps.home);
  const { member, session } = await loadMember({
    stateDir: dir,
    keychain: deps.keychain,
    env: deps.env,
  });

  if (!opts.wrap) {
    deps.stdout(`${encodeMember(member)}\n`);
    return;
  }

  const walletPass = deps.env.WALLET_PASS;
  if (!walletPass) {
    throw new CliError("WALLET_PASS_MISSING", "--wrap needs WALLET_PASS in the environment");
  }
  const { line0, passwordSalt } = wrapEncLine(member.privatekey, walletPass);
  const wrapped: WrappedMember = {
    v: 1,
    wrapped: true,
    rootId: member.rootId,
    applicationPath: member.applicationPath,
    applicationId: 17,
    privatekey: line0,
    pubkey: member.pubkey,
    passwordSalt,
  };
  deps.stderr(
    "warning: --wrap output is not consumable by the shipped action (D3 ships the plaintext path);\n" +
      "         the runner would need WALLET_PASS and an unwrap step of its own.\n",
  );
  if (session.passwordSalt && session.passwordSalt === passwordSalt) {
    deps.stderr("warning: re-wrap reused the session salt — expected a fresh one\n");
  }
  deps.stdout(`${Buffer.from(JSON.stringify(wrapped), "utf8").toString("base64")}\n`);
}

export function makeExportMemberCommand(deps: CliDeps): Command {
  return new Command("export-member")
    .description("print the KLAXON_MEMBER secret as one base64 line (once, to stdout)")
    .option("--wrap", "keep the private key ENC:-wrapped under a fresh salt (needs WALLET_PASS)")
    .option("--plaintext", "explicit form of the default: emit the unwrapped credential")
    .option("--out <dest>", "only `-` (stdout) is accepted", "-")
    .action(async (opts: ExportMemberOptions & { plaintext?: boolean }) => {
      if (opts.wrap && opts.plaintext) {
        throw new CliError("BAD_ARGUMENT", "--wrap and --plaintext are mutually exclusive");
      }
      await runExportMember(deps, {
        ...(opts.wrap ? { wrap: true } : {}),
        ...(opts.out !== undefined ? { out: opts.out } : {}),
      });
    });
}
