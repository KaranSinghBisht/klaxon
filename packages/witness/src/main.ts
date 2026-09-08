import { NtfyAlarmAdapter } from "./adapters/alarm-ntfy.js";
import { HederaHcsAdapter } from "./adapters/hcs-hedera.js";
import { GithubOidcAdapter } from "./adapters/oidc-github.js";
import { X402PaymentAdapter } from "./adapters/payment-x402.js";
import { ViemRegistryAdapter } from "./adapters/registry-viem.js";
import { RawGithubSourceAdapter } from "./adapters/source-raw-github.js";
import type { WitnessContext } from "./context.js";
import { createRepos, openDb } from "./db/index.js";
import { loadEnv } from "./env.js";
import { startJwksSnapshot } from "./jobs/jwks-snapshot.js";
import { startOutboxDrain } from "./jobs/outbox-drain.js";
import { startRegistryWatch } from "./jobs/registry-watch.js";
import { createLogger } from "./log.js";
import { systemClock } from "./ports/index.js";
import { buildServer } from "./server.js";

/**
 * Wire the real adapters and listen. Everything that can fail at boot fails here, loudly and
 * before the first request: B §2.6 is explicit that a witness which cannot settle must refuse to
 * start rather than serve a 402 it cannot honour.
 */
async function main(): Promise<void> {
  const config = loadEnv();
  const log = createLogger(config.KLAXON_LOG_LEVEL);
  const db = openDb({ path: config.KLAXON_DB_PATH });
  const repos = createRepos(db);

  const payment = new X402PaymentAdapter(config, log);
  await payment.initialize();

  const hcs = new HederaHcsAdapter(config);
  const registry = new ViemRegistryAdapter(config, repos, log, systemClock);
  const source = new RawGithubSourceAdapter({
    token: config.KLAXON_SOURCE === "api" ? config.GITHUB_TOKEN : undefined,
  });
  const oidc = new GithubOidcAdapter(config);
  const alarm = new NtfyAlarmAdapter(log, {
    baseUrl: config.NTFY_BASE,
    defaultTopic: config.NTFY_DEFAULT_TOPIC,
    network: config.HEDERA_NETWORK,
  });

  const ctx: WitnessContext = {
    config,
    db,
    repos,
    payment,
    hcs,
    registry,
    source,
    oidc,
    alarm,
    clock: systemClock,
    log,
  };

  const watcher = await startRegistryWatch(ctx);
  const drain = startOutboxDrain(ctx);
  const snapshot = startJwksSnapshot(ctx);
  // A missing first snapshot is not a reason to refuse traffic; the daily timer will retry.
  snapshot.runOnce().catch((err) => log.warn({ err }, "initial jwks snapshot failed"));

  const app = buildServer(ctx);
  await app.listen({ host: config.KLAXON_HOST, port: config.PORT });
  log.info(
    { host: config.KLAXON_HOST, port: config.PORT, account: config.witnessAccount },
    "witness listening",
  );

  const shutdown = (signal: string): void => {
    log.info({ signal }, "shutting down");
    watcher.stop();
    drain.stop();
    snapshot.stop();
    hcs.close();
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  // Boot failures must be visible and fatal — a half-wired witness is worse than no witness.
  process.stderr.write(`witness failed to start: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
