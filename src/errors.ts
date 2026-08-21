/**
 * 统一错误类型
 */

export type SqlEngineErrorCode =
  | 'UNSUPPORTED_DIALECT'
  | 'CONNECTION_FAILED'
  | 'QUERY_FAILED'
  | 'TABLE_NOT_FOUND'
  | 'DML_BLOCKED'
  | 'DML_UNSUPPORTED_EXPRESSION'
  | 'TASK_CANCELLED'
  | 'POOL_EXHAUSTED'
  | 'CLIENT_LIMIT_EXCEEDED'
  | 'TASK_QUEUE_CLOSED'
  | 'WORKER_UNAVAILABLE'
  | 'READ_ONLY';

export interface SqlEngineErrorOptions {
  dialect?: string;
  cause?: unknown;
}

export class SqlEngineError extends Error {
  readonly code: SqlEngineErrorCode;
  readonly dialect?: string;
  override readonly cause?: unknown;

  constructor(code: SqlEngineErrorCode, message: string, opts: SqlEngineErrorOptions = {}) {
    super(message);
    this.name = 'SqlEngineError';
    this.code = code;
    this.dialect = opts.dialect;
    this.cause = opts.cause;
  }
}

export function isSqlEngineError(err: unknown): err is SqlEngineError {
  return err instanceof SqlEngineError;
}

/** 把任意错误包装为 SqlEngineError（保留原 message） */
export function wrapError(
  code: SqlEngineErrorCode,
  err: unknown,
  message?: string,
  opts: SqlEngineErrorOptions = {},
): SqlEngineError {
  const raw = err instanceof Error ? err : new Error(String(err));
  return new SqlEngineError(code, message ?? raw.message, { ...opts, cause: raw });
}
