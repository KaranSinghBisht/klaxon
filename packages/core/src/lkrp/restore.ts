import { createRequire } from "node:module";
import { registerSecretMaterial } from "../crypto/mask.js";
import { KlaxonError } from "../errors.js";
import type { KlaxonMember } from "../schema.js";
import { LKRP_APPLICATION_ID, LKRP_SDK_NAME, TRUSTCHAIN_API_PROD } from "./constants.js";

export interface RestoreOptions {
  apiBaseUrl?: string;
}

/**
 * `restoreTrustchain` never touches the device (A §0.3): it signs a server challenge with the
 * member keypair, reads only `rootId`, and recomputes `walletSyncEncryptionKey` over the network.
 * The `withDevice` argument is therefore a throwing stub. This is a liveness dependency on
 * Ledger's production backend on every release — disclosed, never cached (risk 2).
 */
const noDevice = (() => {
  throw new KlaxonError("LKRP_NO_DEVICE", "no hardware device on this host");
}) as unknown as never;

type SdkLike = {
  restoreTrustchain(
    trustchain: { rootId: string; applicationPath: string; walletSyncEncryptionKey: string },
    creds: { privatekey: string; pubkey: string },
  ): Promise<{ walletSyncEncryptionKey: string }>;
};

/** Resolved at runtime only: the Ledger SDK's dependency graph must not gate typechecking or the crypto tests. */
const LKRP_SDK_MODULE = "@ledgerhq/ledger-key-ring-protocol";

async function loadSdk(apiBaseUrl: string): Promise<SdkLike> {
  let mod: {
    getSdk: (
      isMock: boolean,
      ctx: { applicationId: number; name: string; apiBaseUrl: string },
      withDevice: unknown,
    ) => SdkLike;
  };
  try {
    // The SDK ships two builds. Its ESM build (lib-es) uses extensionless relative imports that
    // Node's native loader rejects (`./HWDeviceProvider` → ERR_MODULE_NOT_FOUND); its CJS build
    // (lib/, the `require` export condition) resolves them. Load the CJS one via require so the
    // restore works headless — on the laptop and in the clean CI container alike (Gate A).
    const require = createRequire(import.meta.url);
    mod = require(LKRP_SDK_MODULE);
  } catch (cause) {
    throw new KlaxonError("LKRP_RESTORE_FAILED", `cannot load ${LKRP_SDK_MODULE} on this host`, {
      cause,
    });
  }
  return mod.getSdk(
    false,
    { applicationId: LKRP_APPLICATION_ID, name: LKRP_SDK_NAME, apiBaseUrl },
    noDevice,
  );
}

/** Returns the walletSyncEncryptionKey (hex) for this member. Requires network to Ledger's API. */
export async function restoreWalletSyncKey(
  member: KlaxonMember,
  opts: RestoreOptions = {},
): Promise<string> {
  const sdk = await loadSdk(opts.apiBaseUrl ?? TRUSTCHAIN_API_PROD);
  let tc: { walletSyncEncryptionKey: string };
  try {
    tc = await sdk.restoreTrustchain(
      {
        rootId: member.rootId,
        applicationPath: member.applicationPath,
        walletSyncEncryptionKey: "",
      },
      { privatekey: member.privatekey, pubkey: member.pubkey },
    );
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : "unknown";
    throw new KlaxonError("LKRP_RESTORE_FAILED", `restoreTrustchain failed (${name})`, { cause });
  }
  if (!/^[0-9a-f]{64}$/.test(tc.walletSyncEncryptionKey)) {
    throw new KlaxonError("LKRP_RESTORE_FAILED", "restoreTrustchain returned no encryption key");
  }
  registerSecretMaterial(tc.walletSyncEncryptionKey);
  return tc.walletSyncEncryptionKey;
}
