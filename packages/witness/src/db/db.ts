import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * `node:sqlite` rather than `better-sqlite3` (D6): no native compile in the image, and the
 * synchronous `prepare().run()/.get()/.all()` shape is identical anyway.
 *
 * `schema.sql` is the file of record; it sits next to this module in `src/` and next to the
 * bundle in `dist/`, so `new URL(...)` resolves in both.
 */
export type Db = DatabaseSync;

export interface OpenDbOptions {
  /** `:memory:` in tests. */
  path: string;
}

function schemaSql(): string {
  return readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
}

export function openDb({ path }: OpenDbOptions): Db {
  const db = new DatabaseSync(path);
  // WAL is meaningless for :memory: and SQLite simply answers "memory"; not worth branching on.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(schemaSql());
  return db;
}

/**
 * `BEGIN IMMEDIATE` takes the write lock up front, so checks 8/9/7 read and write under one
 * writer with no upgrade deadlock (A §5.3). Rolls back on any throw.
 */
export function immediateTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A rollback failure means the transaction is already gone; the original error is the story.
    }
    throw err;
  }
}

/** SQLite reports constraint failures by message; this is the only place that string lives. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export function nowIso(clock: () => Date): string {
  return clock().toISOString();
}
