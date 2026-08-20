/**
 * worker 线程池（Node worker_threads 实现）
 * 固定数量 worker，每个 worker 同一时刻只处理一个任务，结果经 postMessage 回传
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { WorkerTaskSpec } from '../../types/queue.js';

export interface WorkerBackend {
  readonly size: number;
  run<T>(spec: WorkerTaskSpec): Promise<T>;
  close(): Promise<void>;
}

interface PendingTask {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const RUNNER_URL = new URL(
  `./task-runner${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`,
  import.meta.url,
);

export class NodeWorkerPool implements WorkerBackend {
  private workers: Worker[] = [];
  private pending: (PendingTask | undefined)[] = [];
  private seq = 0;
  private closed = false;

  constructor(private count: number) {}

  get size(): number {
    return this.workers.length;
  }

  private spawn(index: number): Worker {
    const worker = new Worker(fileURLToPath(RUNNER_URL));
    worker.on('message', (msg: { ok: boolean; result?: unknown; error?: string }) => {
      const task = this.pending[index];
      this.pending[index] = undefined;
      if (!task) return;
      if (msg.ok) task.resolve(msg.result);
      else task.reject(new Error(msg.error ?? 'worker task failed'));
    });
    worker.on('error', (err) => {
      const task = this.pending[index];
      this.pending[index] = undefined;
      if (task) task.reject(err);
      // 崩溃的 worker 移除，下次 run 时重建
      this.workers[index] = undefined!;
    });
    this.workers[index] = worker;
    return worker;
  }

  run<T>(spec: WorkerTaskSpec): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('worker pool closed'));
    }
    // 找空闲 worker（无 pending 任务）
    let index = -1;
    for (let i = 0; i < this.workers.length; i++) {
      if (!this.pending[i]) {
        index = i;
        break;
      }
    }
    if (index === -1) {
      if (this.workers.length >= this.count) {
        // 池满：等一个空闲（简单轮询等待——用 setTimeout 退避）
        return new Promise<T>((resolve, reject) => {
          const tryRun = () => {
            this.run<T>(spec).then(resolve, reject);
          };
          const timer = setInterval(() => {
            if (this.closed) {
              clearInterval(timer);
              reject(new Error('worker pool closed'));
              return;
            }
            for (let i = 0; i < this.workers.length; i++) {
              if (!this.pending[i]) {
                clearInterval(timer);
                tryRun();
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
    await Promise.all(
      workers.map((w) => (w ? w.terminate().catch(() => undefined) : Promise.resolve())),
    );
  }
}
