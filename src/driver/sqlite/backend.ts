/**
 * SQLite 后端抽象：node:sqlite 与 bun:sqlite 的 API 对齐层
 */

/** 预编译语句（与底层驱动解耦的窄接口） */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteBackend {
  readonly path: string;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
