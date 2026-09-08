import type { Db, Repos } from "./db/index.js";
import type { WitnessConfig } from "./env.js";
import type { Logger } from "./log.js";
import type {
  AlarmPort,
  Clock,
  HcsPort,
  OidcPort,
  PaymentPort,
  RegistryPort,
  SourcePort,
} from "./ports/index.js";

/**
 * Everything the HTTP layer is allowed to reach. `server.ts` takes one of these, so every test
 * builds the real routes over fake ports and an in-memory database — no network, ever.
 */
export interface WitnessContext {
  config: WitnessConfig;
  db: Db;
  repos: Repos;
  payment: PaymentPort;
  hcs: HcsPort;
  registry: RegistryPort;
  source: SourcePort;
  oidc: OidcPort;
  alarm: AlarmPort;
  clock: Clock;
  log: Logger;
}
