export type { AlarmPort, RefusalAlarm } from "./alarm.js";
export type { HcsPort, HcsPublished } from "./hcs.js";
export type { OidcPort } from "./oidc.js";
export type {
  OnChainExpectation,
  OnChainOutcome,
  PaymentPort,
  PaymentRequiredAnswer,
  SettleOutcome,
} from "./payment.js";
export type { PolicyAnchor, RegistryPort } from "./registry.js";
export type { SourcePort, WorkflowFile } from "./source.js";
export { SourceFetchError } from "./source.js";

/** Injectable time. Every check that compares against "now" takes it from here. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
