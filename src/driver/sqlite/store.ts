/**
 * SQLite 实例管理：文件库按 path 共享单例（引用计数），:memory: 每次独立实例
 * bun:sqlite 后端用动态导入（Node 运行时不会解析 bun: 模块）
 */
import type { RuntimeName } from '../../types/config.js';
import type { SqliteBackend } from './backend.js';

interface Record {
  backend: SqliteBackend;
  refs: number;
}

const instances = new Map<string, Record>();

/** 获取后端实例；:memory: 永远新建（不同连接是不同库） */
export async function getSqliteBackend(
  path: string,
  runtime: RuntimeName,
): Promise<SqliteBackend> {
  if (path === ':memory:') {
    return createBackend(path, runtime);
  }
  const key = `${runtime}\x00${path}`;
  let rec = instances.get(key);
  if (!rec) {
    rec = { backend: await createBackend(path, runtime), refs: 0 };
    instances.set(key, rec);
  }
  rec.refs++;
  return rec.backend;
}

/** 释放引用；文件库引用归零时关闭实例 */
export function releaseSqliteBackend(path: string, runtime: RuntimeName): void {
  if (path === ':memory:') return; // 内存库由调用方直接 close
  const key = `${runtime}\x00${path}`;
  const rec = instances.get(key);
  if (!rec) return;
  rec.refs--;
  if (rec.refs <= 0) {
    instances.delete(key);
    try {
      rec.backend.close();
    } catch {
      // 忽略关闭错误
    }
  }
}

async function createBackend(path: string, runtime: RuntimeName): Promise<SqliteBackend> {
  if (runtime === 'bun') {
    // 动态导入：bun:sqlite 只在 bun 运行时存在
    const { BunSqliteBackend } = await import('./bun.js');
    return new BunSqliteBackend(path);
  }
  // 动态导入：node:sqlite 在 bun 下不可用，必须延迟加载
  const { NodeSqliteBackend } = await import('./node.js');
  return new NodeSqliteBackend(path);
}

/** 测试辅助 */
export function __resetSqliteInstances(): void {
  for (const rec of instances.values()) {
    try {
      rec.backend.close();
    } catch {
      // ignore
    }
  }
  instances.clear();
}
