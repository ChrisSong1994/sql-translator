/**
 * 分页工具：分页子句检测、LIMIT/OFFSET 提取、分页 SQL 包装
 */

import { stripSqlForSearch } from './normalize.js';

/** 从 SQL 中提取 LIMIT 和 OFFSET 的值（兼容 LIMIT a,b 与 LIMIT a OFFSET b） */
export function extractLimitOffset(sql: string): { limit?: number; offset?: number } {
  const s = stripSqlForSearch(sql);
  let limit: number | undefined;
  let offset: number | undefined;

  // LIMIT a, b（MySQL 逗号语法）优先；命中后不再解析 LIMIT n OFFSET m
  const commaMatches = Array.from(s.matchAll(/\blimit\s+(\d+)\s*,\s*(\d+)/gi));
  if (commaMatches.length) {
    const m = commaMatches[commaMatches.length - 1]!;
    offset = Number(m[1]);
    limit = Number(m[2]);
  } else {
    const offsetMatches = Array.from(s.matchAll(/\blimit\s+(\d+)(?:\s+offset\s+(\d+))?/gi));
    if (offsetMatches.length) {
      const m = offsetMatches[offsetMatches.length - 1]!;
      const l = Number(m[1]);
      const o = m[2] !== undefined ? Number(m[2]) : undefined;
      if (!Number.isNaN(l)) limit = l;
      if (o !== undefined && !Number.isNaN(o)) offset = o;
    }
  }

  if (limit !== undefined && Number.isNaN(limit)) limit = undefined;
  if (offset !== undefined && Number.isNaN(offset)) offset = undefined;

  return { limit, offset };
}

/** 检查 SQL 是否包含分页子句 */
export function hasPaginationClause(sql: string, extraPatterns: RegExp[] = []): boolean {
  const s = stripSqlForSearch(sql);
  const patterns = [/\blimit\b/i, /\boffset\b/i, ...extraPatterns];
  return patterns.some((p) => p.test(s));
}

/**
 * 用 whereClause 包装 SQL
 * MySQL 5.7 无 CTE：走派生表；否则用 CTE（语义等价，CTE 可读性更好）
 */
export function wrapWithWhereClause(
  sql: string,
  whereClause: string,
  opts: { supportsCTE?: boolean } = {},
): string {
  if (!whereClause) return sql;
  if (opts.supportsCTE === false) {
    return `SELECT * FROM (${sql}) AS __t WHERE ${whereClause}`;
  }
  return `WITH __t AS (${sql}) SELECT * FROM __t WHERE ${whereClause}`;
}

/** 生成分页 SQL（LIMIT/OFFSET，MySQL/PG/SQLite 通用） */
export function buildPagedSql(baseSql: string, limit: number, offset: number): string {
  return `${baseSql} LIMIT ${Math.max(limit, 0)} OFFSET ${Math.max(offset, 0)}`;
}

/** 生成总数 SQL */
export function buildCountSql(baseSql: string): string {
  return `SELECT COUNT(1) AS total FROM (${baseSql}) AS __t2`;
}
