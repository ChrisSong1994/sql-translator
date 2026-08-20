/**
 * bun:sqlite 环境声明（Node 侧 typecheck 通过用；bun 运行时内置）
 */
declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, options?: Record<string, unknown>);
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }

  export interface RunResult {
    changes: number;
    lastInsertRowid: number;
  }

  export class Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
}
