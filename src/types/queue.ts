/**
 * 任务队列类型（并发 / 优先级 / 超时 / 取消 / worker 多线程）
 */

import type { IntrospectTask, IntrospectRunner } from './task.js';

/** 任务队列选项（config.queue 或 TaskQueue 构造参数） */
export interface TaskQueueOptions {
  /** 进程内异步并发，默认 = os.availableParallelism() */
  concurrency?: number;
  /** worker 线程数（CPU 密集任务池），默认 = min(4, cpu) */
  workerCount?: number;
  /** 是否启用 worker 线程，默认 true */
  useWorkers?: boolean;
  /** 任务默认超时（ms），默认不限制 */
  timeoutMs?: number;
}

export interface EnqueueOptions {
  /** 数值越大越先执行，默认 0 */
  priority?: number;
  /** true = offload 到 worker 线程池（CPU 密集任务）；需要任务可序列化（见 WorkerTaskSpec） */
  worker?: boolean;
  /** 取消排队中/执行中的任务 */
  signal?: AbortSignal;
  /** 单次任务超时覆盖（ms） */
  timeoutMs?: number;
}

/** worker 任务规格：CPU 密集任务必须能以「模块 + 导出函数 + 参数」形式描述 */
export interface WorkerTaskSpec {
  /** 模块路径（绝对路径或可 import 的 specifier） */
  module: string;
  /** 模块导出的函数名 */
  fn: string;
  /** 序列化参数（structuredClone 兼容） */
  args?: unknown[];
}

export interface TaskQueue {
  enqueue<T>(fn: (() => T | Promise<T>) | WorkerTaskSpec, opts?: EnqueueOptions): Promise<T>;
  /** 长任务形态：支持进度上报与取消（内部复用 core/task.ts 执行器） */
  introspect<T>(runner: IntrospectRunner<T>): IntrospectTask<T>;
  waitIdle(): Promise<void>;
  /** 排队中任务数 */
  size(): number;
  /** 关闭队列与 worker 池；close 后 enqueue 报错 */
  close(): Promise<void>;
}
