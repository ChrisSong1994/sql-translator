/**
 * ClientManager / 连接池注册表类型（多数据源平台）
 */

import type { PoolOptions } from './config.js';

/** 每数据源池的实时状态 */
export interface PoolStats {
  active: number;
  idle: number;
  waiting: number;
  createdTotal: number;
  destroyedTotal: number;
}

/** 全局池指标（manager.metrics()） */
export interface PoolMetrics {
  /** 已登记 client 数 */
  clients: number;
  /** 存活的池数 */
  pools: number;
  active: number;
  idle: number;
  waiting: number;
  createdTotal: number;
  destroyedTotal: number;
}

export interface ClientManagerOptions {
  /** 每数据源池默认参数 */
  defaultPool?: PoolOptions;
  /** 全局 client 数上限（防泄漏），默认 500 */
  maxClients?: number;
  /** 空闲池 LRU 淘汰 */
  lru?: {
    enabled?: boolean;
    /** 空闲池数量上限，超过时淘汰最久未用的，默认 50 */
    maxIdlePools?: number;
  };
}
