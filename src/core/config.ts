/**
 * 连接配置归一化与指纹计算
 */

import type { ConnectionConfig, SslOptions } from '../types/config.js';

/** 默认端口 */
export const DEFAULT_PORTS: Record<string, number> = {
  mysql: 3306,
  postgresql: 5432,
  sqlite: 0,
  mongodb: 27017,
};

/** 归一化配置：填充默认值（端口、用户名别名等），不修改入参 */
export function normalizeConfig(config: ConnectionConfig): ConnectionConfig {
  const out: Record<string, any> = { ...config };

  // 兼容 user / username 字段名差异
  if (out.user && !out.username) out.username = out.user;
  if (out.username && !out.user) out.user = out.username;

  if (out.port === undefined && DEFAULT_PORTS[config.type] !== undefined) {
    out.port = DEFAULT_PORTS[config.type];
  }

  // 归一化 SSL
  if (out.ssl && typeof out.ssl === 'object' && out.ssl.enabled === undefined) {
    out.ssl = { enabled: true, ...out.ssl } as SslOptions;
  }

  return out as ConnectionConfig;
}

/**
 * 计算连接配置指纹（连接池注册表 key）
 * 密码变更 → 指纹变化 → 不复用旧池；用 \x00 作分隔符防止字段值拼接碰撞
 */
export function fingerprintConfig(config: ConnectionConfig): string {
  const c = config as any;
  const ssl = c.ssl as SslOptions | undefined;
  const parts: string[] = [];

  if (config.type === 'sqlite') {
    return ['sqlite', String(c.database)].join('\x00');
  }

  parts.push(
    config.type,
    String(c.host ?? (config.type === 'mongodb' ? 'localhost' : '')),
    String(c.port ?? DEFAULT_PORTS[config.type] ?? ''),
    String(c.database ?? ''),
    String(c.user ?? c.username ?? ''),
    String(c.password ?? ''),
    String(c.schema ?? (config.type === 'postgresql' ? 'public' : '')),
    ssl?.enabled ? `ssl:${ssl.mode ?? 'default'}` : 'nossl',
  );

  return parts.join('\x00');
}

/** 规范化 + 指纹一步完成 */
export function configKey(config: ConnectionConfig): string {
  return fingerprintConfig(normalizeConfig(config));
}
