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

/**
 * The quieter half: a secret was released, and here is enough of the request to answer "did I
 * expect this?" without opening a laptop — which secret, into which environment, from which
 * workflow, on which run. `h` is the handle for the rest: the `released` message on the topic.
 *
 * It must reach the phone at a *lower* priority than a refusal. A release notice that shouts as
 * loudly as a refusal trains the operator to ignore both, and the refusal is the one that matters.
 */
export interface ReleaseAlarm {
  topic: string | null;
  secret: string;
  environment: string;
  repository: string;
  /** `owner/repo/.github/workflows/deploy.yml@refs/heads/main`, verbatim from the token. */
  workflowRef: string;
  runId: string;
  runAttempt: string;
  /** The commitment hash — what to look up on the topic when the answer is "no, I did not". */
  h: string;
  payTx: string;
  tinybars: string;
}

export interface AlarmPort {
  /** Returns void on purpose: nothing in the request path may await or depend on this. */
  refused(event: RefusalAlarm): void;
  /** Same contract as `refused`, at a lower notification priority. */
  released(event: ReleaseAlarm): void;
}
