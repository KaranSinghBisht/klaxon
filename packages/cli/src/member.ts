import { type KlaxonMember, KlaxonMemberSchema, memberPublicKeyHex } from "@klaxon/core";
import { KEYCHAIN_SERVICE, keychainAccount } from "./config/paths.js";
import { CliError } from "./errors.js";
import {
  type KeychainReader,
  parseKeychainValue,
  resolvePrivateKey,
} from "./wallet-cli/keychain.js";
import { readSession, requireTrustchain, type WalletSession } from "./wallet-cli/session.js";

export interface LoadMemberArgs {
  stateDir: string;
  keychain: KeychainReader;
  env: NodeJS.ProcessEnv;
  /** Injected in tests and by `export-member` when it has already read the file. */
  session?: WalletSession;
}

export interface LoadedMember {
  member: KlaxonMember;
  session: WalletSession;
  /** True when the keychain value was `ENC:`-wrapped and had to be opened with `WALLET_PASS`. */
  wasWrapped: boolean;
}

/**
 * Assembles the `KLAXON_MEMBER` credential from the two things wallet-cli leaves on the laptop:
 * the OS keychain entry (private key, optionally the public key) and `session.yaml` (trustchain
 * meta, `passwordSalt`). Held in memory only — never written by anything but the operator's own
 * redirection of `export-member`'s stdout.
 */
export async function loadMember(a: LoadMemberArgs): Promise<LoadedMember> {
  const session = a.session ?? readSession(a.stateDir);
  const account = keychainAccount(a.stateDir);
  const raw = await a.keychain(KEYCHAIN_SERVICE, account);
  if (!raw) {
    throw new CliError(
      "KEYCHAIN_MISSING",
      `no keychain entry ${KEYCHAIN_SERVICE}/${account} — run \`wallet-cli ring init\` on this machine`,
    );
  }
  const value = parseKeychainValue(raw);
  const privatekey = resolvePrivateKey({
    value,
    walletPass: a.env.WALLET_PASS,
    passwordSalt: session.passwordSalt,
  });
  // A §3.5: wallet-cli derives the compressed secp256k1 point when line 1 is absent.
  const pubkey = (value.line1 ?? memberPublicKeyHex(privatekey)).toLowerCase();
  const trustchain = requireTrustchain(session);
  const member = KlaxonMemberSchema.parse({
    v: 1,
    rootId: trustchain.rootId,
    applicationPath: trustchain.applicationPath,
    applicationId: 17,
    privatekey,
    pubkey,
  });
  return { member, session, wasWrapped: value.line0.startsWith("ENC:") };
}
