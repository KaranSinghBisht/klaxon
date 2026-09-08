import * as core from "@actions/core";
import { STATE_COMMITMENT, STATE_PAY_TX } from "./state.js";

/** The slice of `@actions/core` the post step uses. */
export interface PostCore {
  getState(name: string): string;
  info(message: string): void;
  debug(message: string): void;
  summary: {
    addRaw(
      text: string,
      addEOL?: boolean,
    ): { write(options?: { overwrite?: boolean }): Promise<unknown> };
  };
}

/** `0.0.X@1788848437.031176249` → `0.0.X-1788848437-031176249`, the form explorers link by (C6). */
function dashed(txId: string): string {
  return txId.replace("@", "-").replace(/\.(?=\d+$)/, "-");
}

function summaryFor(h: string, payTx: string): string {
  const paid =
    payTx.length > 0
      ? `\nPaid by \`${payTx}\` — https://hashscan.io/testnet/transaction/${dashed(payTx)}\n`
      : "";
  return `### KLAXON\n\nRelease commitment \`${h}\`\n${paid}\nVerify it against the topic and the payment: \`npx klaxon verify\`\n`;
}

/**
 * Runs at job end. It touches no secret material: `::add-mask::` is honoured by the runner for the
 * rest of the job, so the released value is never persisted anywhere for this step to re-mask. All
 * it does is put the commitment hash and the payment that bought it somewhere a reviewer (and the
 * demo camera) can read without scrolling the log.
 */
export async function post(c: PostCore = core): Promise<void> {
  const h = c.getState(STATE_COMMITMENT);
  if (h.length === 0) {
    c.debug("KLAXON: no commitment in state — the release did not complete");
    return;
  }
  const payTx = c.getState(STATE_PAY_TX);
  try {
    await c.summary.addRaw(summaryFor(h, payTx), true).write();
  } catch (err) {
    c.debug(`KLAXON: step summary unavailable (${err instanceof Error ? err.message : "unknown"})`);
  }
  c.info(`KLAXON: release commitment ${h}${payTx.length > 0 ? ` · paid ${payTx}` : ""}`);
}

// esbuild bundles this file to `dist/post.js`, the action's `post:` entry.
if (process.env.GITHUB_ACTIONS === "true" && process.env.VITEST === undefined) {
  void post();
}
