/**
 * bun:sqlite 后端（Bun ≥ 1.1 内置）
 */
import { Database } from 'bun:sqlite';
import type { SqliteBackend, SqliteStatement } from './backend.js';

export class BunSqliteBackend implements SqliteBackend {
  private db: Database;

  constructor(readonly path: string) {
    this.db = new Database(path);
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) => {
        const r = stmt.run(...params);
        return {
          changes: r.changes,
          lastInsertRowid: r.lastInsertRowid,
        };
      },
      get: (...params: unknown[]) => stmt.get(...params) as unknown,
      all: (...params: unknown[]) => stmt.all(...params) as unknown[],
    };
  }

  close(): void {
    this.db.close();
  }
}
