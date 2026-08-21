/**
 * 驱动注册入口：内置方言在此注册
 */
import { registerDriver } from './registry.js';
import { sqliteDriver } from './sqlite/index.js';
import { mysqlDriver } from './mysql/index.js';

registerDriver(sqliteDriver);
registerDriver(mysqlDriver);

export * from './registry.js';
export * from './interface.js';
