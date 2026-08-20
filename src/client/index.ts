/**
 * 极简客户端入口：createClient(config)
 * 零成本轻量操作（不建连接）；底层连接池全局共享（defaultRegistry）
 */
import type { ConnectionConfig } from '../types/config.js';
import { DbClient } from './client.js';
import { defaultRegistry } from './registry.js';
import { ClientManager } from './manager.js';

/** 创建绑定 config 的 client（懒建池：首次真实调用才建立连接） */
export function createClient(config: ConnectionConfig): DbClient {
  return new DbClient(defaultRegistry, config);
}

/** 创建多数据源管理器 */
export function createClientManager(options?: ConstructorParameters<typeof ClientManager>[0]): ClientManager {
  return new ClientManager(options);
}

export { DbClient } from './client.js';
export { ClientManager } from './manager.js';
export { PoolRegistry, defaultRegistry } from './registry.js';
