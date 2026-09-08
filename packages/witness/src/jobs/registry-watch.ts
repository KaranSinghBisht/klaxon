import type { WitnessContext } from "../context.js";

/**
 * D8 — starts the Sepolia watcher. The polling loop itself lives in the adapter because the cursor
 * and the batching are RPC concerns; this module owns the lifecycle so `main.ts` has one place to
 * start and stop it, and `/health` has one place to ask how far behind it is.
 *
 * `auto_stop_machines = false` in `fly.toml` is what keeps this running (B §7.3): a stopped
 * machine simply does not see `PolicyCommitted` or `Unrevoked` until it starts again.
 */
export interface WatcherHandle {
  stop(): void;
}

export async function startRegistryWatch(ctx: WitnessContext): Promise<WatcherHandle> {
  await ctx.registry.start();
  ctx.log.info(
    { registry: ctx.config.KLAXON_REGISTRY, confirmations: ctx.config.CONFIRMATIONS },
    "watching sepolia registry",
  );
  return { stop: () => ctx.registry.stop() };
}
