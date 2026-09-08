import { NO_ENVIRONMENT } from "@klaxon/core";
import type { Logger } from "../log.js";
import type { AlarmPort, RefusalAlarm } from "../ports/index.js";

/**
 * D29 — the phone on the desk. Topic is `klaxon-<32 hex>` chosen at `init`: ntfy topics are public
 * and unauthenticated, so the name *is* the password, and these alarms name secrets and repos.
 *
 * Priority 5 breaks through Do Not Disturb; `Click` opens HashScan on the attacker's own payment,
 * which is the detail that lands on camera. Never awaited, never load-bearing: a push failure must
 * not turn a correct refusal into a 503.
 */
export interface NtfyOptions {
  baseUrl: string;
  defaultTopic?: string | undefined;
  network?: string;
  fetchImpl?: typeof fetch;
}

export class NtfyAlarmAdapter implements AlarmPort {
  private readonly baseUrl: string;
  private readonly defaultTopic: string | undefined;
  private readonly network: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly log: Logger,
    opts: NtfyOptions,
  ) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.defaultTopic = opts.defaultTopic;
    this.network = opts.network ?? "testnet";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  refused(event: RefusalAlarm): void {
    const topic = event.topic ?? this.defaultTopic;
    if (!topic) return;
    void this.send(topic, event).catch((err) => {
      this.log.warn({ err }, "ntfy publish threw");
    });
  }

  private async send(topic: string, e: RefusalAlarm): Promise<void> {
    const hbar = (Number(e.tinybars) / 100_000_000)
      .toFixed(8)
      .replace(/0+$/, "")
      .replace(/\.$/, "");
    const body = [
      // The `"(none)"` sentinel means the job declared no `environment:` at all. Saying that in
      // words is the line that has to read correctly on a phone screen, on camera.
      e.environment === NO_ENVIRONMENT
        ? `${e.secret} requested by a job with no environment`
        : `${e.secret} requested for environment ${e.environment}`,
      `run ${e.runId} attempt ${e.runAttempt} · ${e.repository}`,
      `Paid ${hbar} ℏ · tx ${e.payTx}`,
      `Refused (${e.class}/${e.check}): ${e.reason}`,
      e.revoked ? "Project revoked." : "Project not revoked.",
    ].join("\n");

    const res = await this.fetchImpl(`${this.baseUrl}/${topic}`, {
      method: "POST",
      headers: {
        Title: `KLAXON refused ${e.secret}`,
        Priority: "5",
        Tags: "rotating_light,lock",
        Click: `https://hashscan.io/${this.network}/transaction/${e.payTx}`,
        Markdown: "no",
      },
      body,
    });
    if (!res.ok) this.log.warn({ status: res.status }, "ntfy publish failed");
  }
}
