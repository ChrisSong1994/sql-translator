/**
 * node:sqlite 后端（Node ≥ 22.5 内置）
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { SqliteBackend, SqliteStatement } from './backend.js';

export class NodeSqliteBackend implements SqliteBackend {
  private db: DatabaseSync;

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') {
      // WAL 提升并发读性能（文件库）
      this.db.exec('PRAGMA journal_mode = WAL');
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    const stmt: StatementSync = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) => {
        const r = stmt.run(...(params as any[]));
        return {
          changes: Number(r.changes),
          lastInsertRowid: Number(r.lastInsertRowid),
        };
      },
      get: (...params: unknown[]) => stmt.get(...(params as any[])) as unknown,
      all: (...params: unknown[]) => stmt.all(...(params as any[])) as unknown[],
    };
  }

  close(): void {
    this.db.close();
  }
}
