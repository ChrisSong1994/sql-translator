#!/usr/bin/env node
/**
 * 等待测试数据库就绪（TCP 端口轮询）
 * 用法：node scripts/wait-for-db.mjs [超时秒数]
 * 默认检查 docker-compose.yml 中声明的端口
 */
import net from 'node:net';

const DEFAULTS = [
  { name: 'mysql5', host: '127.0.0.1', port: 33061 },
  { name: 'mysql8', host: '127.0.0.1', port: 33062 },
  { name: 'mariadb', host: '127.0.0.1', port: 33063 },
  { name: 'postgres', host: '127.0.0.1', port: 54321 },
  { name: 'mongodb', host: '127.0.0.1', port: 27017 },
  { name: 'mongo-rs', host: '127.0.0.1', port: 27018 },
];

const timeoutSec = Number(process.argv[2] ?? 90);
const checkPort = (host, port) =>
  new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    sock.setTimeout(2000);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
  });

const deadline = Date.now() + timeoutSec * 1000;
for (const target of DEFAULTS) {
  let ok = false;
  while (!ok && Date.now() < deadline) {
    ok = await checkPort(target.host, target.port);
    if (!ok) await new Promise((r) => setTimeout(r, 2000));
  }
  if (ok) {
    console.log(`[wait-for-db] ${target.name} (${target.host}:${target.port}) 就绪`);
  } else {
    console.error(`[wait-for-db] ${target.name} 在 ${timeoutSec}s 内未就绪`);
    process.exitCode = 1;
  }
}
