import type { Repos } from "../db/index.js";
import { unrevokeEnvelope } from "../hcs/envelope.js";
import type { Logger } from "../log.js";
import type { Clock } from "../ports/index.js";

/**
 * What a `KlaxonRegistry` log means for local state. Split out from the viem adapter so the rules
 * can be tested without an RPC: the transport is uninteresting, the state transitions are not.
 */
export interface RegistryLog {
  eventName?: string | undefined;
  args?: Record<string, unknown> | undefined;
  blockNumber?: bigint | null | undefined;
  transactionHash?: string | null | undefined;
}

export interface RegistryEventDeps {
  repos: Repos;
  clock: Clock;
  log: Logger;
}

export function applyRegistryEvent(deps: RegistryEventDeps, entry: RegistryLog): void {
  const args = entry.args ?? {};
  const projectId = stripHexPrefix(String(args.p ?? ""));
  if (!projectId) return;

  switch (entry.eventName) {
    case "PolicyCommitted": {
      const hash = stripHexPrefix(String(args.hash ?? ""));
      deps.repos.projects.setPolicyAnchor(projectId, hash, Number(entry.blockNumber ?? 0n));
      deps.log.info({ project_id: projectId, policy_hash: hash }, "policy anchor updated");
      break;
    }
    case "Unrevoked": {
      const epoch = Number(args.epoch ?? 0);
      deps.repos.projects.setChainEpoch(projectId, epoch);
      // PROTOCOL §7: the topic carries the whole lifecycle, so coming back from a revocation is
      // recorded there too, with the Sepolia transaction a reader can check the device signed.
      // Enqueued rather than published — the drain job owns every submit, so a slow HCS never
      // stalls the poll loop and a restart does not lose the message.
      const project = deps.repos.projects.get(projectId);
      if (project) {
        const at = deps.clock().toISOString();
        deps.repos.outbox.enqueue(
          project.topic_id,
          "unrevoke",
          unrevokeEnvelope({ ts: at, projectId, epoch, sepoliaTx: entry.transactionHash ?? "" }),
          at,
        );
      }
      deps.log.info({ project_id: projectId, epoch }, "revocation lifted on chain");
      break;
    }
    case "Registered": {
      deps.repos.projects.setOwner(projectId, String(args.owner ?? ""));
      deps.log.info({ project_id: projectId }, "project claimed on chain");
      break;
    }
    default:
      break;
  }
}

/** `bytes32` arrives `0x`-prefixed; `project_id` is stored as bare lowercase hex. */
function stripHexPrefix(value: string): string {
  return value.startsWith("0x") ? value.slice(2).toLowerCase() : value.toLowerCase();
}
