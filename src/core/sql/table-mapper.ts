/**
 * SQL 表名映射工具（迁移自 WizBuild sql-table-mapper.ts）
 * 将用户 SQL 中的逻辑表名（可能带 schema 前缀）替换为物理表名（如 SQLite 表名）
 *
 * 支持格式：
 * - 裸表名：FROM 表名 / FROM "表名" / FROM '表名' / FROM `表名`
 * - Schema 限定：FROM "数据源名"."数据表名" / FROM 数据源名.数据表名
 * - 带 alias：FROM "表名" AS t / FROM "表名" t
 */

const TABLE_KEYWORDS = 'FROM|JOIN|INNER\\s+JOIN|LEFT\\s+JOIN|RIGHT\\s+JOIN|FULL\\s+JOIN|CROSS\\s+JOIN';
const ANY_QUOTED_IDENTIFIER = `(?:"[^"]+"|'[^']+'|\`[^\`]+\`)`;
const BARE_IDENTIFIER = '[a-zA-Z_\\u4e00-\\u9fff][a-zA-Z0-9_\\u4e00-\\u9fff]*';
const IDENTIFIER = `(?:${ANY_QUOTED_IDENTIFIER}|${BARE_IDENTIFIER})`;
const SCHEMA_PREFIX = `(?:${IDENTIFIER}\\.)`;
const ALIAS_PATTERN = '(?:\\s+(?:AS\\s+)?(?:' + IDENTIFIER + '))?';

/** 将 tableNameMapping 的 entries 按 key 长度降序排序（复合 key 优先） */
function sortMappingEntries(mapping: Map<string, string>): [string, string][] {
  return [...mapping.entries()].sort((a, b) => b[0].length - a[0].length);
}

/**
 * 替换 SQL 中的表名为物理表名
 * @param mapping 逻辑表名 → 物理表名；复合 key（"数据源名.表名"）优先于裸名
 */
export function replaceTableNamesInSql(
  sql: string,
  tableNameMapping: Map<string, string>,
): string {
  let result = sql;

  for (const [tableName, sqliteTableName] of sortMappingEntries(tableNameMapping)) {
    const isCompoundKey = tableName.includes('.');

    if (isCompoundKey) {
      const [schemaPart, tablePart] = tableName.split('.', 2);
      const escapedSchema = escapeRegExp(schemaPart!);
      const escapedTable = escapeRegExp(tablePart!);

      const doubleQuotedCompound = new RegExp(
        `(\\b(?:${TABLE_KEYWORDS})\\s+)"${escapedSchema}"\\."${escapedTable}"(${ALIAS_PATTERN})`,
        'gi',
      );
      result = result.replace(doubleQuotedCompound, `$1"${sqliteTableName}"$2`);

      const singleQuotedCompound = new RegExp(
        `(\\b(?:${TABLE_KEYWORDS})\\s+)'${escapedSchema}'\\.'${escapedTable}'(${ALIAS_PATTERN})`,
        'gi',
      );
      result = result.replace(singleQuotedCompound, `$1"${sqliteTableName}"$2`);

      const backtickQuotedCompound = new RegExp(
        `(\\b(?:${TABLE_KEYWORDS})\\s+)\`${escapedSchema}\`\\.\`${escapedTable}\`(${ALIAS_PATTERN})`,
        'gi',
      );
      result = result.replace(backtickQuotedCompound, `$1"${sqliteTableName}"$2`);

      const bareCompound = new RegExp(
        `(\\b(?:${TABLE_KEYWORDS})\\s+)${escapedSchema}\\.${escapedTable}(${ALIAS_PATTERN})`,
        'gi',
      );
      result = result.replace(bareCompound, `$1"${sqliteTableName}"$2`);
    } else {
      const escapedName = escapeRegExp(tableName);

      const doubleQuoted = new RegExp(
        `(\\b(?:${TABLE_KEYWORDS})\\s+)(?:${SCHEMA_PREFIX})?"${escapedName}"(${ALIAS_PATTERN})`,
        'gi',
      );
      result = result.replace(doubleQuoted, `$1"${sqliteTableName}"$2`);

      const singleQuoted = new RegExp(
        `(\\b(?:${TABLE_KEYWORDS})\\s+)(?:${SCHEMA_PREFIX})?'${escapedName}'(${ALIAS_PATTERN})`,
        'gi',
      );
      result = result.replace(singleQuoted, `$1"${sqliteTableName}"$2`);

      const backtickQuoted = new RegExp(
        `(\\b(?:${TABLE_KEYWORDS})\\s+)(?:${SCHEMA_PREFIX})?\`${escapedName}\`(${ALIAS_PATTERN})`,
        'gi',
      );
      result = result.replace(backtickQuoted, `$1"${sqliteTableName}"$2`);

      const bareName = new RegExp(
        `(\\b(?:${TABLE_KEYWORDS})\\s+)(?:${SCHEMA_PREFIX})?${escapedName}(${ALIAS_PATTERN})`,
        'gi',
      );
      result = result.replace(bareName, `$1"${sqliteTableName}"$2`);
    }
  }

  return result;
}

/** 去除标识符引号 */
export function stripQuotes(identifier: string): string {
  if (
    (identifier.startsWith('"') && identifier.endsWith('"')) ||
    (identifier.startsWith("'") && identifier.endsWith("'")) ||
    (identifier.startsWith('`') && identifier.endsWith('`'))
  ) {
    return identifier.slice(1, -1);
  }
  return identifier;
}

/** 从 SQL 中提取用户引用的表名（裸名 + schema-qualified） */
export function extractTableNamesFromSql(sql: string): Set<string> {
  const tableNames = new Set<string>();

  const compoundDoubleQuoted = new RegExp(
    `\\b(?:${TABLE_KEYWORDS})\\s+(${ANY_QUOTED_IDENTIFIER})\\.(${ANY_QUOTED_IDENTIFIER})`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = compoundDoubleQuoted.exec(sql)) !== null) {
    tableNames.add(`${stripQuotes(match[1]!)}.${stripQuotes(match[2]!)}`);
  }

  const compoundBare = new RegExp(
    `\\b(?:${TABLE_KEYWORDS})\\s+(${BARE_IDENTIFIER})\\.(${BARE_IDENTIFIER})`,
    'gi',
  );
  while ((match = compoundBare.exec(sql)) !== null) {
    tableNames.add(`${match[1]}.${match[2]}`);
  }

  const simpleNamePattern = new RegExp(
    `\\b(?:${TABLE_KEYWORDS})\\s+(${ANY_QUOTED_IDENTIFIER}|${BARE_IDENTIFIER})`,
    'gi',
  );
  while ((match = simpleNamePattern.exec(sql)) !== null) {
    const name = stripQuotes(match[1]!);
    let isCompoundPart = false;
    tableNames.forEach((existing) => {
      if (existing.endsWith(`.${name}`)) isCompoundPart = true;
    });
    if (!isCompoundPart) tableNames.add(name);
  }

  return tableNames;
}

/** 验证表名替换结果，返回警告列表 */
export function validateTableNameReplacement(
  originalSql: string,
  replacedSql: string,
  tableNameMapping: Map<string, string>,
): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];

  const originalTableNames = extractTableNamesFromSql(originalSql);
  for (const name of originalTableNames) {
    const bareName = name.includes('.') ? name.split('.').pop()! : name;
    const hasMapping = tableNameMapping.has(name) || tableNameMapping.has(bareName);
    if (!hasMapping) {
      warnings.push(`表 "${name}" 在映射中未找到对应的物理表名`);
    }
  }

  for (const [logicalName] of tableNameMapping) {
    const bareName = logicalName.includes('.') ? logicalName.split('.').pop()! : logicalName;
    const residualPattern = new RegExp(
      `\\b(?:${TABLE_KEYWORDS})\\s+(?:${SCHEMA_PREFIX})?"${escapeRegExp(bareName)}"`,
      'gi',
    );
    if (residualPattern.test(replacedSql)) {
      warnings.push(`表 "${bareName}" 可能未被替换`);
    }
  }

  return { valid: warnings.length === 0, warnings };
}

/** 正则转义 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
