/**
 * worker 线程执行入口（Node worker_threads 侧）
 * 收到 { module, fn, args } → 动态 import 模块 → 调用导出函数 → 回传结果
 */
import { parentPort } from 'node:worker_threads';

interface WorkerMessage {
  module: string;
  fn: string;
  args?: unknown[];
}

parentPort?.on('message', async (msg: WorkerMessage) => {
  try {
    const mod = await import(msg.module);
    const fn = (mod as Record<string, unknown>)[msg.fn];
    if (typeof fn !== 'function') {
      throw new Error(`module "${msg.module}" 未导出函数 "${msg.fn}"`);
    }
    const result = await (fn as (...args: unknown[]) => unknown)(...(msg.args ?? []));
    parentPort?.postMessage({ ok: true, result });
  } catch (err) {
    const e = err as Error;
    parentPort?.postMessage({ ok: false, error: e?.stack || String(err) });
  }
});
