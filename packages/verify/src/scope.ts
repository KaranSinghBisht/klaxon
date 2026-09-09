import { type Finding, finding } from "./errors.js";
import {
  type RegistryTimeline,
  type RegistryTransport,
  registrationOf,
  ZERO_ADDRESS,
} from "./registry.js";

/**
 * Everything this verifier audits — the topic, the witness account, the registry — is a string
 * the audited party handed the auditor, and the witness manifest even prints the command to
 * paste. So the scope itself is checked, and whatever cannot be checked is said out loud rather
 * than passed over.
 *
 * `KlaxonRegistry` stores three mappings: `owner`, `policyHash` and `epoch`. It records no HCS
 * topic and no Hedera account, and neither does the policy anchored on it, so the topic id and
 * the witness account are cross-checkable only against the topic's own submitters — the account
 * that paid for each message on the 1-of-2 submit KeyList (PROTOCOL §7).
 */
export interface Scope {
  /** The project id the envelopes on the supplied topic carry — one per topic (PROTOCOL §7). */
  projectId: string | null;
  /** Further project ids on the same topic: the topic is not the single project it claims to be. */
  extraProjectIds: string[];
  /** From the registry itself; `null` when it could not be asked a question with an answer. */
  registered: boolean | null;
  /** The address that claimed the project — compare it by eye with the operator's Ledger. */
  owner: string | null;
  /** How `registered` was established, or why it could not be. */
  basis: string;
  /** Hedera accounts that paid to submit the messages this run read off the topic. */
  topicSubmitters: string[];
  /** `--witness` is among them; `null` when the mirror node returned no payer at all. */
  witnessSubmitted: boolean | null;
}

export interface ScopeInput {
  witnessAccount: string;
  /** In first-seen order, as `verify` derives them from the topic. */
  projectIds: readonly string[];
  topicSubmitters: readonly string[];
  timeline: RegistryTimeline | null;
  transport: RegistryTransport | null;
}

export interface ScopeResult {
  scope: Scope;
  findings: Finding[];
}

/**
 * `owner(p)` first, because only contract state can distinguish "never registered" from "claimed
 * before the block range we scanned". The event is the fallback, and a fallback that finds
 * nothing is reported as unknown — never as proof of anything.
 */
async function resolveOwner(
  input: ScopeInput,
  projectId: string,
): Promise<{ registered: boolean | null; owner: string | null; basis: string }> {
  const { timeline, transport } = input;
  if (!timeline) {
    return { registered: null, owner: null, basis: "no --registry was given" };
  }
  if (transport?.readOwner) {
    try {
      const owner = await transport.readOwner(projectId);
      if (owner.toLowerCase() === ZERO_ADDRESS) {
        return {
          registered: false,
          owner: null,
          basis: "KlaxonRegistry.owner(p) is the zero address",
        };
      }
      return { registered: true, owner, basis: "KlaxonRegistry.owner(p)" };
    } catch {
      // A flaky RPC must not turn into a verdict; fall through to the events we already read.
    }
  }
  const claim = registrationOf(timeline, projectId);
  if (claim) {
    return {
      registered: true,
      owner: claim.owner,
      basis: `Registered in block ${claim.blockNumber}`,
    };
  }
  return {
    registered: null,
    owner: null,
    basis: `no Registered event in blocks ${timeline.fromBlock}-${timeline.toBlock}; the claim may predate them`,
  };
}

/** Tie the scope the operator supplied to the chain, and name the parts that cannot be tied. */
export async function checkScope(input: ScopeInput): Promise<ScopeResult> {
  const findings: Finding[] = [];
  const [projectId, ...extraProjectIds] = input.projectIds;
  const submitters = [...new Set(input.topicSubmitters)].sort();

  if (!projectId) {
    return {
      scope: {
        projectId: null,
        extraProjectIds: [],
        registered: null,
        owner: null,
        basis: "no envelope on the topic names a project id",
        topicSubmitters: submitters,
        witnessSubmitted:
          submitters.length === 0 ? null : submitters.includes(input.witnessAccount),
      },
      findings,
    };
  }

  const resolved = await resolveOwner(input, projectId);
  if (resolved.registered === false) {
    findings.push(
      finding(
        "PROJECT_NOT_REGISTERED",
        `the topic publishes for project ${projectId}, which KlaxonRegistry has no owner for — nothing anchors the policy this report checked against`,
      ),
    );
  }

  return {
    scope: {
      projectId,
      extraProjectIds,
      registered: resolved.registered,
      owner: resolved.owner,
      basis: resolved.basis,
      topicSubmitters: submitters,
      witnessSubmitted: submitters.length === 0 ? null : submitters.includes(input.witnessAccount),
    },
    findings,
  };
}
