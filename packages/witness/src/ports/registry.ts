/**
 * The Sepolia `KlaxonRegistry` mirror (D8): `getLogs` polling with a cursor persisted in SQLite,
 * never `watchContractEvent` — a Fly machine that restarts must not silently skip blocks.
 */
export interface PolicyAnchor {
  /** `sha256` of the exact committed bytes of `klaxon.policy.json`, 64 hex. */
  hash: string;
  blockNumber: number;
}

export interface RegistryPort {
  /** Begin polling. Resolves once the first tick has been scheduled, not once it has caught up. */
  start(): Promise<void>;
  stop(): void;
  getPolicyHash(projectId: string): Promise<PolicyAnchor | null>;
  getEpoch(projectId: string): Promise<number>;
  /** Seconds since the cursor last advanced — `/health` reports it as `sepolia_cursor_lag_s`. */
  lagSeconds(): number | null;
}
