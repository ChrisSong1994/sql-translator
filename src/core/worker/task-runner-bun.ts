/**
 * bun worker 执行入口（Bun Worker 侧，web-worker 风格）
 */
declare const self: {
  onmessage: ((e: { data: any }) => void) | null;
  postMessage(msg: unknown): void;
};

interface WorkerMessage {
  module: string;
  fn: string;
  args?: unknown[];
}

self.onmessage = async (e: { data: WorkerMessage }) => {
  const msg = e.data;
  try {
    const mod = await import(msg.module);
    const fn = (mod as Record<string, unknown>)[msg.fn];
    if (typeof fn !== 'function') {
      throw new Error(`module "${msg.module}" 未导出函数 "${msg.fn}"`);
    }
    const result = await (fn as (...args: unknown[]) => unknown)(...(msg.args ?? []));
    self.postMessage({ ok: true, result });
  } catch (err) {
    const e2 = err as Error;
    self.postMessage({ ok: false, error: e2?.stack || String(err) });
  }
};
