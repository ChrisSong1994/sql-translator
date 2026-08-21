/**
 * MongoDB SQL 翻译：SELECT → {query | pipeline}（@synatic/noql）
 */
import noqlPkg from '@synatic/noql';
import type { Document } from 'mongodb';

type NoqlParse = (sql: string) => NoqlResult;
interface NoqlResult {
  type: 'query' | 'aggregate';
  collection?: string;
  collections?: string[];
  query?: Document;
  projection?: Document;
  pipeline?: Document[];
  limit?: number;
  offset?: number;
}

const parseSQL = (noqlPkg as unknown as { parseSQL?: NoqlParse }).parseSQL ??
  (noqlPkg as unknown as NoqlParse);

/** 翻译 SELECT 语句 */
export function translateSelect(sql: string): NoqlResult {
  return parseSQL(sql);
}

/** 翻译 WHERE 子句 → Mongo match 文档（兼容带/不带 WHERE 前缀） */
export function translateWhereToMatch(whereClause: string): Document {
  const trimmed = String(whereClause ?? '')
    .trim()
    .replace(/^where\b/i, '')
    .trim();
  if (!trimmed) return {};
  const { query } = parseSQL(`SELECT * FROM __t WHERE ${trimmed}`);
  return query || {};
}

/** 将附加 match 与已有 query 用 $and 合并（避免覆盖） */
export function mergeMatch(base: Document | undefined, additional: Document | undefined): Document {
  if (!additional || Object.keys(additional).length === 0) return base ?? {};
  if (!base || Object.keys(base).length === 0) return additional;
  return { $and: [base, additional] };
}

export type { NoqlResult };
