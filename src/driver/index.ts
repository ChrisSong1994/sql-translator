/**
 * 驱动注册入口：内置方言在此注册
 */
import { registerDriver } from './registry.js';
import { sqliteDriver } from './sqlite/index.js';

registerDriver(sqliteDriver);

export * from './registry.js';
export * from './interface.js';
