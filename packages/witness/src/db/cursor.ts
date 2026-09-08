import type { Db } from "./db.js";

/** Scalars that must survive a Fly machine restart — the Sepolia block cursor above all (D8). */
export class CursorRepo {
  constructor(private readonly db: Db) {}

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM cursor WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO cursor (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, at);
  }

  updatedAt(key: string): string | null {
    const row = this.db.prepare("SELECT updated_at FROM cursor WHERE key = ?").get(key) as
      | { updated_at: string }
      | undefined;
    return row?.updated_at ?? null;
  }
}

export const SEPOLIA_CURSOR_KEY = "sepolia_block";
