import type { AlarmPort, RefusalAlarm } from "../../src/ports/index.js";

/** Records what would have buzzed the phone. Never throws — the real one must not either. */
export class FakeAlarmPort implements AlarmPort {
  readonly fired: RefusalAlarm[] = [];

  refused(event: RefusalAlarm): void {
    this.fired.push(event);
  }
}
