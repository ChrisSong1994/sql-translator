/**
 * 驱动注册入口：内置方言在此注册
 */
import { registerDriver } from './registry.js';
import { sqliteDriver } from './sqlite/index.js';
import { mysqlDriver } from './mysql/index.js';
import { postgresqlDriver } from './postgresql/index.js';
import { mongodbDriver } from './mongodb/index.js';

registerDriver(sqliteDriver);
registerDriver(mysqlDriver);
registerDriver(postgresqlDriver);
registerDriver(mongodbDriver);

export * from './registry.js';
export * from './interface.js';
