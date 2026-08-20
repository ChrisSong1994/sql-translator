/**
 * 任务队列：并发上限 / 优先级 / 超时 / 取消 / worker 多线程 offload
 */
import { SqlEngineError } from '../errors.js';
import { availableParallelism } from 'node:os';
import { createTask } from '../types/task.js';
import type { IntrospectContext, IntrospectRunner, IntrospectTask } from '../types/task.js';
import type {
  EnqueueOptions,
  TaskQueue,
  TaskQueueOptions,
  WorkerTaskSpec,
} from '../types/queue.js';
import { createWorkerBackend, type WorkerBackend } from './worker/index.js';

interface QueueItem {
  id: number;
  fn: (() => unknown) | WorkerTaskSpec;
  opts?: EnqueueOptions;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  priority: number;
}

export class TaskQueueImpl implements TaskQueue {
  private queue: QueueItem[] = [];
  private active = 0;
  private closed = false;
  private seq = 0;
  private idleWaiters: (() => void)[] = [];
  private workerBackend: WorkerBackend | null = null;
  private workerBackendPromise: Promise<WorkerBackend> | null = null;

  constructor(private options: TaskQueueOptions = {}) {}

  /** 默认并发 = CPU 数 */
  private get concurrency(): number {
    return this.options.concurrency ?? defaultConcurrency();
  }

  size(): number {
    return this.queue.length + this.active;
  }

  /**
   * 入队执行
   * - 传函数：进程内异步执行（I/O 密集任务默认方式）
   * - 传 WorkerTaskSpec + opts.worker=true：offload 到 worker 线程（CPU 密集任务）
   */
  enqueue<T>(fn: (() => T | Promise<T>) | WorkerTaskSpec, opts: EnqueueOptions = {}): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new SqlEngineError('TASK_QUEUE_CLOSED', 'task queue has been closed'),
      );
    }

    if (opts.worker && typeof fn === 'function') {
      return Promise.reject(
        new SqlEngineError(
          'WORKER_UNAVAILABLE',
          'worker 任务必须是可序列化的 WorkerTaskSpec（{ module, fn, args }），闭包无法跨线程执行',
        ),
      );
    }

    if (opts.signal?.aborted) {
      return Promise.reject(new SqlEngineError('TASK_CANCELLED', 'task cancelled before run'));
    }

    const priority = opts.priority ?? 0;

    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        id: ++this.seq,
        fn: fn as () => unknown,
        opts,
        resolve: resolve as (v: unknown) => void,
        reject,
        priority,
      };

      // 按优先级降序插入（稳定排序：同优先级按入队顺序）
      let lo = 0;
      let hi = this.queue.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.queue[mid]!.priority < priority) hi = mid;
        else lo = mid + 1;
      }
      this.queue.splice(lo, 0, item);

      this.pump();
    });
  }

  /** 长任务形态：支持进度上报与取消 */
  introspect<T>(runner: IntrospectRunner<T>): IntrospectTask<T> {
    return createTask<T>((ctx: IntrospectContext) =>
      this.enqueue(() => runner(ctx), { signal: ctx.signal }),
    );
  }

  waitIdle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // 拒绝所有排队任务
    const pending = this.queue.splice(0);
    for (const item of pending) {
      item.reject(new SqlEngineError('TASK_QUEUE_CLOSED', 'task queue has been closed'));
    }
    await this.waitIdle();
    if (this.workerBackend) {
      await this.workerBackend.close();
      this.workerBackend = null;
      this.workerBackendPromise = null;
    }
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0 && !this.closed) {
      const item = this.queue.shift()!;
      this.active++;
      void this.execute(item).finally(() => {
        this.active--;
        this.pump();
        if (this.active === 0 && this.queue.length === 0) {
          const waiters = this.idleWaiters.splice(0);
          for (const w of waiters) w();
        }
      });
    }
  }

  private async execute(item: QueueItem): Promise<void> {
    const { opts } = item;

    if (opts?.signal?.aborted) {
      item.reject(new SqlEngineError('TASK_CANCELLED', 'task cancelled'));
      return;
    }

    // 排队期间被取消（signal 触发）
    const abortHandler = () => {
      item.reject(new SqlEngineError('TASK_CANCELLED', 'task cancelled'));
    };
    opts?.signal?.addEventListener('abort', abortHandler, { once: true });

    try {
      const exec = opts?.worker
        ? this.runInWorker(item.fn as WorkerTaskSpec)
        : Promise.resolve().then(() => (item.fn as () => unknown)());

      const timeoutMs = opts?.timeoutMs ?? this.options.timeoutMs;
      const result = await withTimeout(exec, timeoutMs, item.id);
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      opts?.signal?.removeEventListener('abort', abortHandler);
    }
  }

  private runInWorker(spec: WorkerTaskSpec): Promise<unknown> {
    return this.getWorkerBackend().then((backend) => backend.run(spec));
  }

  private getWorkerBackend(): Promise<WorkerBackend> {
    if (this.options.useWorkers === false) {
      return Promise.reject(
        new SqlEngineError('WORKER_UNAVAILABLE', 'worker 已被禁用（useWorkers: false）'),
      );
    }
    if (!this.workerBackend) {
      this.workerBackendPromise ??= Promise.resolve().then(() =>
        createWorkerBackend({ workerCount: this.options.workerCount }),
      );
      this.workerBackendPromise
        .then((backend) => {
          this.workerBackend = backend;
        })
        .catch(() => {
          this.workerBackendPromise = null;
        });
      return this.workerBackendPromise;
    }
    return Promise.resolve(this.workerBackend);
  }
}

function defaultConcurrency(): number {
  if (typeof globalThis !== 'undefined' && 'navigator' in globalThis) {
    const nav = (globalThis as any).navigator;
    const hw = nav?.hardwareConcurrency;
    if (typeof hw === 'number' && hw > 0) return hw;
  }
  try {
    return Math.max(1, availableParallelism?.() ?? 4);
  } catch {
    return 4;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, id: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SqlEngineError('QUERY_FAILED', `task #${id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
