/**
 * 测试辅助：可精确计数的 fake 驱动（registry/manager 生命周期测试用）
 */
import { configKey } from '../../src/core/config.js';
import { registerDriver } from '../../src/driver/registry.js';
import type { SqlDriver, PoolHandle } from '../../src/driver/interface.js';

export interface FakeDriverHandle extends PoolHandle {
  readonly id: string;
}

export function createFakeDriver(dialect: string) {
  let poolCount = 0;
  const destroyedPools: string[] = [];
  let pingCount = 0;

  const driver: SqlDriver = {
    dialect,
    async createPool(config) {
      const id = `${dialect}-pool-${++poolCount}`;
      let destroyed = false;
      const handle: FakeDriverHandle = {
        // 指纹必须与 registry 的 key（configKey）一致，否则 release/invalidate 找不到记录
        id,
        fingerprint: configKey(config),
        config,
        get destroyed() {
          return destroyed;
        },
        get stats() {
          return {
            active: 0,
            idle: destroyed ? 0 : 1,
            waiting: 0,
            createdTotal: 1,
            destroyedTotal: destroyed ? 1 : 0,
          };
        },
        async ping() {
          pingCount++;
        },
        async destroy() {
          destroyed = true;
          destroyedPools.push(id);
        },
      };
      return handle;
    },
    async testConnection() {
      return { success: true, message: `${dialect} ok` };
    },
    async runSql() {
      return { rows: [], total: 0 };
    },
    async getTableList() {
      return ['t1', 't2'];
    },
    async getColumns() {
      return [];
    },
    async getPreviewRows() {
      return [];
    },
    async getRowsCount() {
      return 0;
    },
    async getTableSchema() {
      throw new Error('fake: getTableSchema not implemented');
    },
  };

  registerDriver(driver);

  return {
    driver,
    destroyedPools,
    getPoolCount: () => poolCount,
    getPingCount: () => pingCount,
  };
}

/** 构造 fake config（ConnectionConfig 联合类型之外，测试用 as any） */
export function fakeConfig(dialect: string, extra: Record<string, unknown> = {}): any {
  return { type: dialect, host: '127.0.0.1', database: 'testdb', ...extra };
}
