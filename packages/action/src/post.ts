import * as core from "@actions/core";
import { STATE_COMMITMENT, STATE_VALUE } from "./state.js";

/** The slice of `@actions/core` the post step uses. */
export interface PostCore {
  getState(name: string): string;
  setSecret(secret: string): void;
  info(message: string): void;
  debug(message: string): void;
  summary: {
    addRaw(
      text: string,
      addEOL?: boolean,
    ): { write(options?: { overwrite?: boolean }): Promise<unknown> };
  };
}

/**
 * Runs at job end. `::add-mask::` is honoured by the runner for the rest of the job, so re-masking
 * here is idempotent belt-and-braces for this process's own log; the summary line is what puts the
 * commitment hash somewhere a reviewer (and the demo camera) can read it without scrolling.
 */
export async function post(c: PostCore = core): Promise<void> {
  const value = c.getState(STATE_VALUE);
  if (value.length > 0) c.setSecret(value);

  const h = c.getState(STATE_COMMITMENT);
  if (h.length === 0) {
    c.debug("KLAXON: no commitment in state — the release did not complete");
    return;
  }
  const md = `### KLAXON\n\nRelease commitment \`${h}\`\n\nVerify it against the topic and the payment: \`npx klaxon verify\`\n`;
  try {
    await c.summary.addRaw(md, true).write();
  } catch (err) {
    c.debug(`KLAXON: step summary unavailable (${err instanceof Error ? err.message : "unknown"})`);
  }
  c.info(`KLAXON: release commitment ${h}`);
}

// esbuild bundles this file to `dist/post.js`, the action's `post:` entry.
if (process.env.GITHUB_ACTIONS === "true" && process.env.VITEST === undefined) {
  void post();
}
