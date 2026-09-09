import { NO_ENVIRONMENT } from "@klaxon/core";
import type { Logger } from "../log.js";
import type { AlarmPort, RefusalAlarm, ReleaseAlarm } from "../ports/index.js";
import { OUTBOUND_TIMEOUT_MS, timeoutSignal } from "./http.js";

/**
 * D29 — the phone on the desk. Topic is `klaxon-<32 hex>` chosen at `init`: ntfy topics are public
 * and unauthenticated, so the name *is* the password, and these alarms name secrets and repos.
 *
 * Refusals go out at priority 5, which breaks through Do Not Disturb; `Click` opens HashScan on
 * the attacker's own payment, which is the detail that lands on camera. Releases go out at
 * priority 2, below the phone's default, so they accumulate quietly and answer "did I expect
 * this?" without training the operator to swipe away the one alert that matters.
 *
 * Never awaited, never load-bearing: a push failure must not turn a correct refusal into a 503.
 */
export interface NtfyOptions {
  baseUrl: string;
  defaultTopic?: string | undefined;
  network?: string;
  /** Per-call deadline — an ntfy that hangs must not keep a refusal's push alive for minutes. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class NtfyAlarmAdapter implements AlarmPort {
  private readonly baseUrl: string;
  private readonly defaultTopic: string | undefined;
  private readonly network: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly log: Logger,
    opts: NtfyOptions,
  ) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.defaultTopic = opts.defaultTopic;
    this.network = opts.network ?? "testnet";
    this.timeoutMs = opts.timeoutMs ?? OUTBOUND_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  refused(event: RefusalAlarm): void {
    const topic = event.topic ?? this.defaultTopic;
    if (!topic) return;
    const body = [
      // The `"(none)"` sentinel means the job declared no `environment:` at all. Saying that in
      // words is the line that has to read correctly on a phone screen, on camera.
      event.environment === NO_ENVIRONMENT
        ? `${event.secret} requested by a job with no environment`
        : `${event.secret} requested for environment ${event.environment}`,
      `run ${event.runId} attempt ${event.runAttempt} · ${event.repository}`,
      `Paid ${hbar(event.tinybars)} ℏ · tx ${event.payTx}`,
      `Refused (${event.class}/${event.check}): ${event.reason}`,
      event.revoked ? "Project revoked." : "Project not revoked.",
    ].join("\n");

    this.post(topic, {
      title: `KLAXON refused ${event.secret}`,
      // Priority 5 is the maximum: it breaks through Do Not Disturb, which is the entire point of
      // a refusal. Nothing else the witness sends is allowed to be this loud.
      priority: "5",
      tags: "rotating_light,lock",
      payTx: event.payTx,
      body,
    });
  }

  /**
   * The receipt, not the alarm. A release is the expected case, so it goes out at priority 2 —
   * below the phone's default, so it lands silently and accumulates. A notice that shouts as
   * loudly as a refusal trains the operator to swipe both away, and the refusal is the one that
   * has to survive that habit.
   */
  released(event: ReleaseAlarm): void {
    const topic = event.topic ?? this.defaultTopic;
    if (!topic) return;
    const body = [
      `${event.secret} → ${event.environment}`,
      `run ${event.runId} attempt ${event.runAttempt} · ${event.repository}`,
      event.workflowRef,
      `Paid ${hbar(event.tinybars)} ℏ · tx ${event.payTx}`,
      // The handle for everything else: this is what to look up on the topic when the answer to
      // "did I expect this?" turns out to be no.
      `h ${event.h}`,
    ].join("\n");

    this.post(topic, {
      title: `KLAXON released ${event.secret}`,
      priority: "2",
      tags: "key",
      payTx: event.payTx,
      body,
    });
  }

  /** Fire-and-forget: nothing in the request path may await this or depend on it succeeding. */
  private post(topic: string, message: NtfyMessage): void {
    void this.send(topic, message).catch((err) => {
      this.log.warn({ err }, "ntfy publish threw");
    });
  }

  private async send(topic: string, message: NtfyMessage): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/${topic}`, {
      method: "POST",
      headers: {
        Title: message.title,
        Priority: message.priority,
        Tags: message.tags,
        // Tapping the notification opens a public explorer on the payment itself — the runner's
        // own transfer, whichever way the request went.
        Click: `https://hashscan.io/${this.network}/transaction/${message.payTx}`,
        Markdown: "no",
      },
      body: message.body,
      signal: timeoutSignal(this.timeoutMs),
    });
    if (!res.ok) this.log.warn({ status: res.status }, "ntfy publish failed");
  }
}

interface NtfyMessage {
  title: string;
  priority: string;
  tags: string;
  payTx: string;
  body: string;
}

/** Tinybars to ℏ for human eyes only; the exact figure travels as `tx` and on the topic. */
function hbar(tinybars: string): string {
  return (Number(tinybars) / 100_000_000).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}
