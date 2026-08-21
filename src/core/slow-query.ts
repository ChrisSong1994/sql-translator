/**
 * 慢查询日志
 */
import type { LoggingOptions, SlowQueryEntry } from '../types/config.js';

export interface SlowQueryContext {
  dialect: string;
  sql: string;
  params?: unknown[];
  durationMs: number;
  fingerprint?: string;
}

const defaultLogFn = (entry: SlowQueryEntry) => {
  console.warn(
    `[slow-query] ${entry.durationMs.toFixed(1)}ms ${entry.dialect} ${entry.fingerprint ?? ''}: ${entry.sql}`,
  );
};

/** 记录慢查询（未配置 slowQueryMs 或未超阈值时静默；slowQueryMs=0 记录所有） */
export function maybeLogSlowQuery(
  logging: LoggingOptions | undefined,
  ctx: SlowQueryContext,
): void {
  if (logging?.slowQueryMs === undefined || ctx.durationMs < logging.slowQueryMs) return;
  const entry: SlowQueryEntry = {
    type: 'slow-query',
    dialect: ctx.dialect,
    sql: ctx.sql,
    params: ctx.params,
    durationMs: ctx.durationMs,
    fingerprint: ctx.fingerprint,
    at: new Date().toISOString(),
  };
  (logging.logFn ?? defaultLogFn)(entry);
}
