import { createPublicClient, http, parseAbiItem } from "viem";
import { sepolia } from "viem/chains";
import { SEPOLIA_CURSOR_KEY } from "../db/cursor.js";
import type { Repos } from "../db/index.js";
import type { WitnessConfig } from "../env.js";
import type { Logger } from "../log.js";
import type { Clock, PolicyAnchor, RegistryPort } from "../ports/index.js";
import { applyRegistryEvent } from "./registry-events.js";

/**
 * D8 — `getLogs` polling with a cursor persisted in SQLite, not `watchContractEvent`.
 *
 * `watchContractEvent` holds process state and swallows transport errors into `onError`; a Fly
 * machine that restarts then has gaps it cannot know about. An explicit loop with a persisted
 * cursor is restart-safe, and the cursor already has a home.
 *
 * Three confirmations by default (Sepolia reorgs are shallow, 3 blocks ≈ 36 s); the shoot drops
 * to 1 and says so on camera.
 */
const POLICY_COMMITTED = parseAbiItem("event PolicyCommitted(bytes32 indexed p, bytes32 hash)");
const UNREVOKED = parseAbiItem("event Unrevoked(bytes32 indexed p, uint64 epoch)");
const REGISTERED = parseAbiItem("event Registered(bytes32 indexed p, address owner)");

/** Public RPCs cap `eth_getLogs` ranges; 5000 blocks is comfortably inside every provider's limit. */
const MAX_BLOCK_SPAN = 5000n;

export class ViemRegistryAdapter implements RegistryPort {
  private readonly client: ReturnType<typeof createPublicClient>;
  private timer: NodeJS.Timeout | null = null;
  private lastAdvance: Date | null = null;

  constructor(
    private readonly config: WitnessConfig,
    private readonly repos: Repos,
    private readonly log: Logger,
    private readonly clock: Clock,
  ) {
    this.client = createPublicClient({
      chain: sepolia,
      transport: http(config.SEPOLIA_RPC_URL),
    });
  }

  async start(): Promise<void> {
    await this.tick().catch((err) => this.log.error({ err }, "initial sepolia poll failed"));
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log.error({ err }, "sepolia poll failed"));
    }, this.config.KLAXON_REGISTRY_POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const head = await this.client.getBlockNumber();
    const safe = head - BigInt(this.config.CONFIRMATIONS);
    const stored = this.repos.cursor.get(SEPOLIA_CURSOR_KEY);
    const from = stored ? BigInt(stored) : BigInt(this.config.KLAXON_REGISTRY_DEPLOY_BLOCK);
    if (safe <= from) return;
    const to = from + MAX_BLOCK_SPAN > safe ? safe : from + MAX_BLOCK_SPAN;

    const logs = await this.client.getLogs({
      address: this.config.KLAXON_REGISTRY as `0x${string}`,
      events: [POLICY_COMMITTED, UNREVOKED, REGISTERED],
      fromBlock: from + 1n,
      toBlock: to,
      strict: true,
    });
    const deps = { repos: this.repos, clock: this.clock, log: this.log };
    for (const entry of logs) applyRegistryEvent(deps, entry);

    this.repos.cursor.set(SEPOLIA_CURSOR_KEY, to.toString(), this.clock().toISOString());
    this.lastAdvance = this.clock();
  }

  async getPolicyHash(projectId: string): Promise<PolicyAnchor | null> {
    const project = this.repos.projects.get(projectId);
    if (!project?.policy_hash) return null;
    return { hash: project.policy_hash, blockNumber: project.policy_block ?? 0 };
  }

  async getEpoch(projectId: string): Promise<number> {
    return this.repos.projects.get(projectId)?.chain_epoch ?? 0;
  }

  lagSeconds(): number | null {
    const at = this.lastAdvance ?? parseIso(this.repos.cursor.updatedAt(SEPOLIA_CURSOR_KEY));
    if (!at) return null;
    return Math.max(0, Math.round((this.clock().getTime() - at.getTime()) / 1000));
  }
}

function parseIso(value: string | null): Date | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t) : null;
}
