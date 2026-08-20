/**
 * 统一查询/写操作结果类型
 */

/** 字段定义（统一展示结构） */
export interface Field {
  field_name: string;
  custom_name: string;
  field_desc?: string;
  /** 方言原生类型（如 bigint / varchar(255) / int4） */
  field_type: string;
  /** 统一展示类型：string | number | boolean | date | json | binary | object | array */
  display_type: string;
  is_primary?: 0 | 1;
}

/** SELECT 查询结果 */
export interface QueryResult {
  rows: any[];
  fields?: Field[];
  /** 用户 SQL 自带 LIMIT 时为近似值（rows.length） */
  total?: number;
  offset?: number;
  limit?: number;
  /** SQL 执行耗时（ms），由 facade 挂载 */
  duration?: number;
}

/** DML 写操作结果 */
export interface WriteResult {
  /** 受影响行数 */
  affectedRows: number;
  /** 单条插入的自增主键 / Mongo _id */
  insertId?: number | string;
  /** RETURNING 回读行 / Mongo 批量插入 _id 列表 */
  returning?: any[];
  duration?: number;
}

export type ExecResult = QueryResult | WriteResult;

/** SQL 执行请求 */
export interface RunSqlRequest {
  sql: string;
  offset?: number;
  limit?: number;
  /** 额外过滤，包装为 WITH __t AS (...) SELECT * FROM __t WHERE ... */
  whereClause?: string;
  /** 参数绑定占位符值（? / $1），与 sql 中的占位符一一对应 */
  params?: unknown[];
}

/** 连接测试结果 */
export interface TestResult {
  success: boolean;
  message: string;
  version?: string;
}

/** 类型守卫：是否为写操作结果 */
export function isWriteResult(result: ExecResult): result is WriteResult {
  return 'affectedRows' in result;
}

/** 类型守卫：是否为查询结果 */
export function isQueryResult(result: ExecResult): result is QueryResult {
  return 'rows' in result;
}
