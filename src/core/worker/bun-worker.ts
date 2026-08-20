/**
 * worker 线程池（Bun Worker 实现）
 * bun 的 Worker 是全局 web-worker 风格构造器：new Worker(url, {type:'module'})
 * 消息事件：addEventListener('message', e => e.data)
 */
import type { WorkerTaskSpec } from '../../types/queue.js';
import type { WorkerBackend } from './node-worker.js';

const RUNNER_URL = new URL(
  `./task-runner-bun${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`,
  import.meta.url,
);

interface BunLikeWorker {
  postMessage(msg: unknown): void;
  terminate?(): void;
  addEventListener(type: 'message' | 'error', cb: (e: any) => void): void;
}

interface PendingTask {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class BunWorkerPool implements WorkerBackend {
  private workers: BunLikeWorker[] = [];
  private pending: (PendingTask | undefined)[] = [];
  private seq = 0;
  private closed = false;

  constructor(private count: number) {}

  get size(): number {
    return this.workers.length;
  }

  private get WorkerCtor(): new (url: URL, opts?: { type?: string }) => BunLikeWorker {
    const ctor = (globalThis as any).Worker as
      | (new (url: URL, opts?: { type?: string }) => BunLikeWorker)
      | undefined;
    if (typeof ctor !== 'function') {
      throw new Error('当前运行时无 Worker 全局构造器（需要 Bun ≥ 1.1）');
    }
    return ctor;
  }

  private spawn(index: number): BunLikeWorker {
    const worker = new this.WorkerCtor(RUNNER_URL, { type: 'module' });
    worker.addEventListener('message', (e: any) => {
      const msg = e.data as { ok: boolean; result?: unknown; error?: string };
      const task = this.pending[index];
      this.pending[index] = undefined;
      if (!task) return;
      if (msg.ok) task.resolve(msg.result);
      else task.reject(new Error(msg.error ?? 'bun worker task failed'));
    });
    worker.addEventListener('error', (err: any) => {
      const task = this.pending[index];
      this.pending[index] = undefined;
      if (task) {
        const e = err?.message ? new Error(String(err.message)) : new Error('bun worker error');
        task.reject(e);
      }
      this.workers[index] = undefined as unknown as BunLikeWorker;
    });
    this.workers[index] = worker;
    return worker;
  }

  run<T>(spec: WorkerTaskSpec): Promise<T> {
    if (this.closed) return Promise.reject(new Error('worker pool closed'));

    // 找空闲 worker
    let index = -1;
    for (let i = 0; i < this.workers.length; i++) {
      if (!this.pending[i]) {
        index = i;
        break;
      }
    }
    if (index === -1) {
      if (this.workers.length >= this.count) {
        // 池满：等一个空闲
        return new Promise<T>((resolve, reject) => {
          const timer = setInterval(() => {
            if (this.closed) {
              clearInterval(timer);
              reject(new Error('worker pool closed'));
              return;
            }
            for (let i = 0; i < this.workers.length; i++) {
              if (!this.pending[i]) {
                clearInterval(timer);
                this.run<T>(spec).then(resolve, reject);
                return;
              }
            }
          }, 1);
        });
      }
      index = this.workers.length;
      this.spawn(index);
    }

    return new Promise<T>((resolve, reject) => {
      this.pending[index!] = { resolve: resolve as (v: unknown) => void, reject };
      this.workers[index!]!.postMessage({ id: ++this.seq, ...spec });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const workers = this.workers;
    this.workers = [];
    this.pending = [];
    workers.forEach((w) => w.terminate?.());
  }
}
