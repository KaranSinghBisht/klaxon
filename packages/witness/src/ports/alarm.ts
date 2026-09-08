/**
 * The phone buzzing on camera (D29). Best-effort and never load-bearing: fired after the reply is
 * sent, never awaited, and a failure must never turn a correct refusal into a 503.
 */
export interface RefusalAlarm {
  topic: string | null;
  secret: string;
  repository: string;
  runId: string;
  runAttempt: string;
  environment: string;
  payTx: string;
  tinybars: string;
  class: "auth" | "policy";
  check: number;
  reason: string;
  revoked: boolean;
}

export interface AlarmPort {
  /** Returns void on purpose: nothing in the request path may await or depend on this. */
  refused(event: RefusalAlarm): void;
}
