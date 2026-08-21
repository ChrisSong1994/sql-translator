/**
 * MongoDB DML 翻译：INSERT/UPDATE/DELETE → Mongo 写操作（node-sql-parser 解析）
 *
 * 分工：
 * - node-sql-parser：INSERT 的 columns/values、UPDATE 的 SET（$set vs $inc 识别）
 * - WHERE 子句：从原始 SQL 提取原文 → noql 翻译（与 SELECT 路径一致）
 * - 参数（?）：先内联进 SQL 再解析（Mongo 无参数化概念，值直接进文档）
 */
import pkg from 'node-sql-parser';
import { SqlEngineError } from '../../errors.js';
import { extractDmlWhere } from '../../core/sql/statement.js';
import { translateWhereToMatch } from './sql-translator.js';
import type { Document } from 'mongodb';

const { Parser } = pkg;
const parser = new Parser();

export interface MongoDmlSpec {
  type: 'insert' | 'update' | 'delete';
  collection: string;
  /** insert */
  documents?: Document[];
  /** update/delete：WHERE 翻译 */
  filter?: Document;
  /** update：{ $set, $inc } */
  updateDoc?: Document;
}

/** 参数内联：'?' → 字面量（数字/布尔/null 原样，字符串单引号转义） */
export function inlineParams(sql: string, params: unknown[]): string {
  if (!params?.length) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = params[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

/** AST 值节点 → JS 值 */
function astValueToJs(node: any): unknown {
  if (!node) return null;
  switch (node.type) {
    case 'number':
      return Number(node.value);
    case 'single_quote_string':
    case 'double_quote_string':
      return String(node.value);
    case 'null':
      return null;
    case 'boolean':
      return node.value === true || String(node.value).toLowerCase() === 'true';
    case 'origin':
      // 内联后 '?' 应已被替换；裸标识符视为字符串
      return String(node.value);
    default:
      throw new SqlEngineError(
        'DML_UNSUPPORTED_EXPRESSION',
        `不支持的表达式节点: ${node.type}（仅支持字面量值）`,
      );
  }
}

/** INSERT → documents */
function translateInsert(ast: any): MongoDmlSpec {
  const collection = ast.table?.[0]?.table;
  if (!collection) throw new SqlEngineError('QUERY_FAILED', '无法解析 INSERT 目标集合');
  const columns: string[] = ast.columns || [];
  const rows: any[] = ast.values?.values || [];
  if (!columns.length || !rows.length) {
    throw new SqlEngineError('DML_UNSUPPORTED_EXPRESSION', 'INSERT 需要显式列与 VALUES');
  }
  const documents = rows.map((row: any) => {
    const values = row.value || [];
    const doc: Document = {};
    columns.forEach((col, i) => {
      doc[col] = astValueToJs(values[i]);
    });
    return doc;
  });
  return { type: 'insert', collection, documents };
}

/** UPDATE → { $set, $inc } */
function translateUpdate(ast: any): MongoDmlSpec {
  const collection = ast.table?.[0]?.table;
  if (!collection) throw new SqlEngineError('QUERY_FAILED', '无法解析 UPDATE 目标集合');
  const $set: Document = {};
  const $inc: Document = {};
  for (const s of ast.set || []) {
    const col: string = s.column;
    const v = s.value;
    // SET n = n + k / n = n - k → $inc
    if (
      v?.type === 'binary_expr' &&
      (v.operator === '+' || v.operator === '-') &&
      v.left?.type === 'column_ref' &&
      v.left?.column === col &&
      v.right?.type === 'number'
    ) {
      $inc[col] = v.operator === '+' ? Number(v.right.value) : -Number(v.right.value);
      continue;
    }
    $set[col] = astValueToJs(v);
  }
  const updateDoc: Document = {};
  if (Object.keys($set).length) updateDoc.$set = $set;
  if (Object.keys($inc).length) updateDoc.$inc = $inc;
  if (!Object.keys(updateDoc).length) {
    throw new SqlEngineError('QUERY_FAILED', 'UPDATE 没有可执行的 SET 子句');
  }
  return { type: 'update', collection, updateDoc };
}

/**
 * 翻译 DML 语句
 * @returns spec（filter 由外部通过 extractDmlWhere + noql 翻译注入，见 MongoDriver.runDml）
 */
export function translateDml(sql: string, params: unknown[]): MongoDmlSpec {
  const inlined = inlineParams(sql, params);
  const ast: any = parser.astify(inlined, { database: 'mysql' });

  if (ast.type === 'insert') return translateInsert(ast);
  if (ast.type === 'update') return translateUpdate(ast);
  if (ast.type === 'delete') {
    const collection = ast.from?.[0]?.table ?? ast.table?.[0]?.table;
    if (!collection) throw new SqlEngineError('QUERY_FAILED', '无法解析 DELETE 目标集合');
    return { type: 'delete', collection };
  }
  throw new SqlEngineError('DML_UNSUPPORTED_EXPRESSION', `不支持的 DML 语句类型: ${ast.type}`);
}

/** 翻译 UPDATE/DELETE 的 WHERE → filter（无 WHERE 返回 {}） */
export function translateDmlFilter(sql: string): Document {
  const where = extractDmlWhere(sql);
  return where ? translateWhereToMatch(where) : {};
}
