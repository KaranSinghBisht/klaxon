import type { PolicyAnchor, RegistryPort } from "../../src/ports/index.js";

/** No RPC: the tests set the anchor directly, the way the real watcher would after a `getLogs`. */
export class FakeRegistryPort implements RegistryPort {
  private readonly anchors = new Map<string, PolicyAnchor>();
  private readonly epochs = new Map<string, number>();
  lag: number | null = 0;
  started = false;

  async start(): Promise<void> {
    this.started = true;
  }

  stop(): void {
    this.started = false;
  }

  setPolicyHash(projectId: string, hash: string, blockNumber = 1): void {
    this.anchors.set(projectId, { hash, blockNumber });
  }

  setEpoch(projectId: string, epoch: number): void {
    this.epochs.set(projectId, epoch);
  }

  async getPolicyHash(projectId: string): Promise<PolicyAnchor | null> {
    return this.anchors.get(projectId) ?? null;
  }

  async getEpoch(projectId: string): Promise<number> {
    return this.epochs.get(projectId) ?? 0;
  }

  lagSeconds(): number | null {
    return this.lag;
  }
}
