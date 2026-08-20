/**
 * SQL 标准化工具
 */

/** 去除末尾分号序列和空白字符 */
export function normalizeSql(sql: string): string {
  return String(sql ?? '')
    .trim()
    .replace(/(?:\s*;+\s*)+$/, '')
    .trim();
}

/**
 * 剥离 SQL 中的注释和字符串常量，用于分析 SQL 结构（如查找关键词）
 */
export function stripSqlForSearch(sql: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;
  let prev = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = i + 1 < sql.length ? sql[i + 1]! : '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += '\n';
        prev = '\n';
      } else {
        out += ' ';
        prev = ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        out += '  ';
        i++;
        prev = '/';
      } else {
        out += ch === '\n' ? '\n' : ' ';
        prev = ch;
      }
      continue;
    }

    if (inSingle) {
      if (!escape && ch === "'") inSingle = false;
      escape = !escape && ch === '\\';
      out += ch === '\n' ? '\n' : ' ';
      prev = ch;
      continue;
    }

    if (inDouble) {
      if (!escape && ch === '"') inDouble = false;
      escape = !escape && ch === '\\';
      out += ch === '\n' ? '\n' : ' ';
      prev = ch;
      continue;
    }

    if (inBacktick) {
      if (ch === '`') inBacktick = false;
      out += ch === '\n' ? '\n' : ' ';
      prev = ch;
      continue;
    }

    escape = false;

    if (
      ch === '-' &&
      next === '-' &&
      (prev === '' || /\s/.test(prev)) &&
      (i + 2 >= sql.length || /\s/.test(sql[i + 2]!))
    ) {
      inLineComment = true;
      out += '  ';
      i++;
      prev = '-';
      continue;
    }

    if (ch === '#') {
      inLineComment = true;
      out += ' ';
      prev = '#';
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      out += '  ';
      i++;
      prev = '*';
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      out += ' ';
      prev = "'";
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      out += ' ';
      prev = '"';
      continue;
    }

    if (ch === '`') {
      inBacktick = true;
      out += ' ';
      prev = '`';
      continue;
    }

    out += ch;
    prev = ch;
  }

  return out;
}
