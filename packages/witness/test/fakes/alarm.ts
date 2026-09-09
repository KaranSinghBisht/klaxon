import type { AlarmPort, RefusalAlarm, ReleaseAlarm } from "../../src/ports/index.js";

/** Records what would have buzzed the phone. Never throws — the real one must not either. */
export class FakeAlarmPort implements AlarmPort {
  readonly fired: RefusalAlarm[] = [];
  /** Release notices, kept apart from refusals so a test cannot mistake one for the other. */
  readonly notices: ReleaseAlarm[] = [];

  refused(event: RefusalAlarm): void {
    this.fired.push(event);
  }

  released(event: ReleaseAlarm): void {
    this.notices.push(event);
  }
}
