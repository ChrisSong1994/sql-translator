/**
 * 语句类型识别与 DML 安全检测
 */

import { stripSqlForSearch } from './normalize.js';

export type StatementType =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'DDL'
  | 'TRANSACTION'
  | 'OTHER'
  | 'UNKNOWN';

/** 识别 SQL 语句类型（基于剥离注释/字符串后的首关键字） */
export function detectStatementType(sql: string): StatementType {
  const s = stripSqlForSearch(sql).trimStart();
  if (!s) return 'UNKNOWN';
  const m = s.match(/^[a-zA-Z]+/);
  if (!m) return 'UNKNOWN';
  const kw = m[0].toUpperCase();
  switch (kw) {
    case 'SELECT':
    case 'WITH':
      return 'SELECT';
    case 'INSERT':
    case 'REPLACE':
      return 'INSERT';
    case 'UPDATE':
      return 'UPDATE';
    case 'DELETE':
      return 'DELETE';
    case 'CREATE':
    case 'ALTER':
    case 'DROP':
    case 'TRUNCATE':
    case 'RENAME':
      return 'DDL';
    case 'BEGIN':
    case 'COMMIT':
    case 'ROLLBACK':
    case 'START':
    case 'SAVEPOINT':
      return 'TRANSACTION';
    default:
      return 'OTHER';
  }
}

export type DmlStatementType = 'INSERT' | 'UPDATE' | 'DELETE';

export function isDmlStatement(type: StatementType): type is DmlStatementType {
  return type === 'INSERT' || type === 'UPDATE' || type === 'DELETE';
}

/**
 * 提取 UPDATE / DELETE 语句的 WHERE 子句原文（保留字符串字面量）
 * 在剥离版上定位 WHERE 位置，再从原始 SQL 截取到末尾（两版字符位置一致）
 * 返回 null 表示无 WHERE（用于 DML 安全护栏）
 */
export function extractDmlWhere(sql: string): string | null {
  const stripped = stripSqlForSearch(sql);
  const type = detectStatementType(sql);
  if (type !== 'UPDATE' && type !== 'DELETE') return null;

  const m = stripped.match(/\bwhere\b/i);
  if (!m || m.index === undefined) return null;
  return sql.slice(m.index);
}

/** UPDATE/DELETE 是否有 WHERE 子句 */
export function hasDmlWhere(sql: string): boolean {
  return extractDmlWhere(sql) !== null;
}

const TABLE_KEYWORDS = 'FROM|JOIN|INNER\\s+JOIN|LEFT\\s+JOIN|RIGHT\\s+JOIN|FULL\\s+JOIN|CROSS\\s+JOIN';
const ANY_QUOTED_IDENTIFIER = `(?:"[^"]+"|'[^']+'|\`[^\`]+\`)`;
const BARE_IDENTIFIER = '[a-zA-Z_\\u4e00-\\u9fff][a-zA-Z0-9_\\u4e00-\\u9fff]*';
const IDENTIFIER = `(?:${ANY_QUOTED_IDENTIFIER}|${BARE_IDENTIFIER})`;

/** 
 * 从 SQL 中提取引用的表名（含 schema-qualified）
 * 注意：在原始 SQL 上做正则（不剥离字符串），与引号标识符/中文表名兼容；
 * 字符串字面量内误匹配的风险 
 * */
export function extractTableNamesFromSql(sql: string): Set<string> {
  const tableNames = new Set<string>();
  const s = sql;

  const stripQuotes = (identifier: string): string => {
    if (
      (identifier.startsWith('"') && identifier.endsWith('"')) ||
      (identifier.startsWith("'") && identifier.endsWith("'")) ||
      (identifier.startsWith('`') && identifier.endsWith('`'))
    ) {
      return identifier.slice(1, -1);
    }
    return identifier;
  };

  // 1. "schema"."table" 复合形式 → "schema.table"
  const compoundQuoted = new RegExp(
    `\\b(?:${TABLE_KEYWORDS})\\s+(${ANY_QUOTED_IDENTIFIER})\\.(${ANY_QUOTED_IDENTIFIER})`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = compoundQuoted.exec(s)) !== null) {
    tableNames.add(`${stripQuotes(match[1]!)}.${stripQuotes(match[2]!)}`);
  }

  // 2. schema.table 裸名复合形式
  const compoundBare = new RegExp(
    `\\b(?:${TABLE_KEYWORDS})\\s+(${BARE_IDENTIFIER})\\.(${BARE_IDENTIFIER})`,
    'gi',
  );
  while ((match = compoundBare.exec(s)) !== null) {
    tableNames.add(`${match[1]}.${match[2]}`);
  }

  // 3. 简单表名（不带 schema 前缀）
  const simpleNamePattern = new RegExp(
    `\\b(?:${TABLE_KEYWORDS})\\s+(${ANY_QUOTED_IDENTIFIER}|${BARE_IDENTIFIER})`,
    'gi',
  );
  while ((match = simpleNamePattern.exec(s)) !== null) {
    const name = stripQuotes(match[1]!);
    let isCompoundPart = false;
    tableNames.forEach((existing) => {
      if (existing.endsWith(`.${name}`)) isCompoundPart = true;
    });
    if (!isCompoundPart) tableNames.add(name);
  }

  // 4. INSERT INTO / UPDATE / DELETE FROM 的目标表
  const intoPattern = new RegExp(
    `\\b(?:INTO|UPDATE)\\s+(${ANY_QUOTED_IDENTIFIER}|${BARE_IDENTIFIER})`,
    'gi',
  );
  while ((match = intoPattern.exec(s)) !== null) {
    tableNames.add(stripQuotes(match[1]!));
  }
  const deletePattern = new RegExp(
    `\\bDELETE\\s+FROM\\s+(${ANY_QUOTED_IDENTIFIER}|${BARE_IDENTIFIER})`,
    'gi',
  );
  while ((match = deletePattern.exec(s)) !== null) {
    tableNames.add(stripQuotes(match[1]!));
  }

  return tableNames;
}

/**
 * 解析 INSERT VALUES 行数（DML 批量上限校验用）
 * @returns 行数；无法解析（如 INSERT ... SELECT）返回 0
 */
export function countInsertValueRows(sql: string): number {
  const s = stripSqlForSearch(sql);
  const m = s.match(/\bINSERT\b[\s\S]*?\bVALUES\s*/i);
  if (!m || m.index === undefined) return 0;
  const rest = s.slice(m.index + m[0].length);
  // 取到第一个完整的括号组（VALUES (..),(..),...）
  let depth = 0;
  let groups = 0;
  let inParen = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '(') {
      if (!inParen) {
        inParen = true;
        groups++;
      }
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        inParen = false;
        // 括号组结束后，若下一非空字符不是逗号，说明 VALUES 结束
        let j = i + 1;
        while (j < rest.length && /\s/.test(rest[j]!)) j++;
        if (rest[j] !== ',') break;
      }
    }
  }
  return groups;
}
