/**
 * 驱动注册表：dialect → SqlDriver
 */
import type { DialectType } from '../types/config.js';
import { SqlEngineError } from '../errors.js';
import type { SqlDriver } from './interface.js';

const drivers = new Map<string, SqlDriver>();

/** 注册驱动（扩展点：第三方方言可注册） */
export function registerDriver(driver: SqlDriver): void {
  drivers.set(driver.dialect, driver);
}

/** 获取驱动，未注册抛 UNSUPPORTED_DIALECT */
export function getDriver(dialect: string): SqlDriver {
  const driver = drivers.get(dialect);
  if (!driver) {
    throw new SqlEngineError(
      'UNSUPPORTED_DIALECT',
      `不支持的方言 "${dialect}"（可用: ${[...drivers.keys()].join(', ') || '暂无'}）`,
      { dialect },
    );
  }
  return driver;
}

/** 获取方言的驱动（不存在返回 undefined） */
export function hasDriver(dialect: DialectType | string): boolean {
  return drivers.has(dialect);
}

/** 列出已注册方言 */
export function listDrivers(): string[] {
  return [...drivers.keys()];
}

/** 测试辅助：清空注册表 */
export function __resetDrivers(): void {
  drivers.clear();
}
