/**
 * worker 后端选择：按运行时创建
 */
import { detectRuntime, type RuntimeName } from '../../runtime.js';
import type { WorkerTaskSpec } from '../../types/queue.js';
import { NodeWorkerPool, type WorkerBackend } from './node-worker.js';
import { BunWorkerPool } from './bun-worker.js';

export type { WorkerBackend } from './node-worker.js';

export interface WorkerPoolOptions {
  /** worker 线程数，默认 min(4, cpu) */
  workerCount?: number;
  runtime?: RuntimeName;
}

/** 创建 worker 后端（Node worker_threads / Bun Worker） */
export function createWorkerBackend(options: WorkerPoolOptions = {}): WorkerBackend {
  const runtime = options.runtime ?? detectRuntime();
  const count = Math.max(1, Math.min(options.workerCount ?? 4, 32));
  if (runtime === 'bun') {
    return new BunWorkerPool(count);
  }
  return new NodeWorkerPool(count);
}

export type { WorkerTaskSpec };
