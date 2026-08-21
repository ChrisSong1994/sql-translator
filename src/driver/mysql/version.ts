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

/** 按 config.version 解析能力（'5' | '8' 强制；'auto'/undefined 走探测） */
export async function resolveMysqlCapabilities(
  k: Knex,
  versionChoice: '5' | '8' | 'auto' | undefined,
): Promise<MysqlCapabilities> {
  if (versionChoice === '5') return MYSQL5_CAPS;
  if (versionChoice === '8') return MYSQL8_CAPS;
  return detectMysqlVersion(k);
}
