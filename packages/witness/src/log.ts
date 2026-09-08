/**
 * Structured JSON lines on stdout. Deliberately tiny and dependency-free.
 *
 * The witness handles share B, the witness master and OIDC tokens; nothing in this module ever
 * stringifies an arbitrary object graph, so a caller must name each field it wants logged. Never
 * pass secret material here — `h`, `pay_tx`, `project_id` and check numbers are the vocabulary.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function serialize(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

export function createLogger(min: LogLevel = "info"): Logger {
  const emit = (level: LogLevel, fields: Record<string, unknown>, msg: string): void => {
    if (ORDER[level] < ORDER[min]) return;
    const record: Record<string, unknown> = { t: new Date().toISOString(), level, msg };
    for (const [k, v] of Object.entries(fields)) record[k] = serialize(v);
    process.stdout.write(`${JSON.stringify(record)}\n`);
  };
  return {
    debug: (f, m) => emit("debug", f, m),
    info: (f, m) => emit("info", f, m),
    warn: (f, m) => emit("warn", f, m),
    error: (f, m) => emit("error", f, m),
  };
}

/** Used by tests so a suite that exercises refusal paths does not spray the terminal. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
