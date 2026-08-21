/**
 * MySQL 版本探测与能力矩阵（5.7 / 8.x 双模式路由）
 */
import type { Knex } from 'knex';

export interface MysqlCapabilities {
  /** 主版本号（5 / 8 / 0=未知） */
  major: number;
  /** CTE（WITH ... AS），MySQL 8+ */
  supportsCTE: boolean;
  /** 窗口函数，MySQL 8+ */
  supportsWindowFunctions: boolean;
  /** JSON 类型，5.7.8+ */
  supportsJson: boolean;
}

export const MYSQL5_CAPS: MysqlCapabilities = {
  major: 5,
  supportsCTE: false,
  supportsWindowFunctions: false,
  supportsJson: true,
};

export const MYSQL8_CAPS: MysqlCapabilities = {
  major: 8,
  supportsCTE: true,
  supportsWindowFunctions: true,
  supportsJson: true,
};

/** 解析 VERSION() 字符串 → 能力矩阵 */
export function parseMysqlVersion(version: string): MysqlCapabilities {
  const m = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return { major: 0, supportsCTE: false, supportsWindowFunctions: false, supportsJson: false };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  return {
    major,
    supportsCTE: major >= 8,
    supportsWindowFunctions: major >= 8,
    supportsJson: major > 5 || (major === 5 && (minor > 7 || (minor === 7 && patch >= 8))),
  };
}

/** 通过 SELECT VERSION() 探测（knex raw 对 mysql2 返回 [rows, fields]） */
export async function detectMysqlVersion(k: Knex): Promise<MysqlCapabilities> {
  const res = (await k.raw('SELECT VERSION() AS v')) as unknown[];
  const rows = (Array.isArray(res) ? res[0] : res) as Array<{ v?: string }>;
  const version = rows?.[0]?.v ?? '';
  return parseMysqlVersion(version);
}

/** 解析 MariaDB VERSION() → 能力矩阵（10.2+ CTE / 10.3+ 窗口函数 / 10.2+ JSON） */
export function parseMariaDbVersion(version: string): MysqlCapabilities {
  // MariaDB 常见格式：'10.11.4-MariaDB'、'5.5.5-10.6.12-MariaDB-0+deb11u1'
  const m = String(version || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return { major: 0, supportsCTE: false, supportsWindowFunctions: false, supportsJson: false };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return {
    major,
    supportsCTE: major >= 10 && minor >= 2,
    supportsWindowFunctions: major >= 10 && minor >= 3,
    supportsJson: major >= 10 && minor >= 2,
  };
}

/** 探测 VERSION() 原始字符串 */
export async function detectVersionString(k: Knex): Promise<string> {
  const res = (await k.raw('SELECT VERSION() AS v')) as unknown[];
  const rows = (Array.isArray(res) ? res[0] : res) as Array<{ v?: string }>;
  return rows?.[0]?.v ?? '';
}

/** 按 config.version 解析能力（强制模式 / auto 探测；isMariaDb 决定解析器） */
export async function resolveMysqlCapabilities(
  k: Knex,
  versionChoice: '5' | '8' | 'auto' | '10' | '11' | undefined,
  isMariaDb = false,
): Promise<MysqlCapabilities> {
  if (!isMariaDb) {
    if (versionChoice === '5') return MYSQL5_CAPS;
    if (versionChoice === '8') return MYSQL8_CAPS;
    return detectMysqlVersion(k);
  }
  // MariaDB：强制模式 10/11 走对应矩阵，auto 探测
  const mariaMajor = versionChoice === '10' ? 10 : versionChoice === '11' ? 11 : 0;
  if (mariaMajor) {
    return {
      major: mariaMajor,
      supportsCTE: true,
      supportsWindowFunctions: mariaMajor >= 11,
      supportsJson: true,
    };
  }
  return parseMariaDbVersion(await detectVersionString(k));
}
