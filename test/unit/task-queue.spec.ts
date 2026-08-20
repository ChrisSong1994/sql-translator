import { describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { TaskQueueImpl } from '../../src/core/task-queue.js';
import { SqlEngineError } from '../../src/errors.js';

const WORKER_MODULE = fileURLToPath(new URL('../fixtures/worker-fn.mjs', import.meta.url));

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('TaskQueueImpl（进程内）', () => {
  test('并发上限：concurrency=2 时同时执行数 ≤ 2', async () => {
    const q = new TaskQueueImpl({ concurrency: 2 });
    let running = 0;
    let peak = 0;
    const jobs = Array.from({ length: 8 }, () =>
      q.enqueue(async () => {
        running++;
        peak = Math.max(peak, running);
        await delay(20);
        running--;
        return 'ok';
      }),
    );
    await Promise.all(jobs);
    expect(peak).toBeLessThanOrEqual(2);
    expect(q.size()).toBe(0);
    await q.close();
  });

  test('优先级：高优先级先执行', async () => {
    const q = new TaskQueueImpl({ concurrency: 1 });
    const order: string[] = [];
    // 先塞一个低优先级任务占住并发位
    const first = q.enqueue(async () => {
      await delay(30);
      order.push('low-first');
    }, { priority: 0 });
    const second = q.enqueue(async () => {
      order.push('high');
    }, { priority: 100 });
    const third = q.enqueue(async () => {
      order.push('low-second');
    }, { priority: 0 });
    await Promise.all([first, second, third]);
    expect(order).toEqual(['low-first', 'high', 'low-second']);
    await q.close();
  });

  test('timeoutMs 超时拒绝', async () => {
    const q = new TaskQueueImpl();
    await expect(
      q.enqueue(async () => {
        await delay(1000);
        return 1;
      }, { timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: 'QUERY_FAILED' });
    await q.close();
  });

  test('AbortSignal：排队中任务取消', async () => {
    const q = new TaskQueueImpl({ concurrency: 1 });
    const ac = new AbortController();
    q.enqueue(async () => {
      await delay(100);
    });
    const p = q.enqueue(async () => 'never', { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    await q.close();
  });

  test('close 后 enqueue 报错', async () => {
    const q = new TaskQueueImpl();
    await q.close();
    await expect(q.enqueue(async () => 1)).rejects.toMatchObject({ code: 'TASK_QUEUE_CLOSED' });
  });

  test('闭包任务 + worker:true → 报错（不可序列化）', async () => {
    const q = new TaskQueueImpl();
    await expect(
      q.enqueue(async () => 1, { worker: true }),
    ).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' });
    await q.close();
  });
});

describe('TaskQueueImpl（worker 多线程，真实 worker_threads）', () => {
  test('WorkerTaskSpec 在 worker 中执行，结果一致', async () => {
    const q = new TaskQueueImpl({ workerCount: 2, useWorkers: true });
    const result = await q.enqueue<number>(
      { module: WORKER_MODULE, fn: 'heavyCompute', args: [1_000_000] },
      { worker: true },
    );
    let expected = 0;
    for (let i = 0; i < 1_000_000; i++) expected += i;
    expect(result).toBe(expected);
    await q.close();
  });

  test('多个 worker 任务并发执行', async () => {
    const q = new TaskQueueImpl({ workerCount: 2, useWorkers: true });
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        q.enqueue<number>({ module: WORKER_MODULE, fn: 'add', args: [i, 10] }, { worker: true }),
      ),
    );
    expect(results).toEqual([10, 11, 12, 13]);
    await q.close();
  });

  test('worker 错误回传（模块不存在）', async () => {
    const q = new TaskQueueImpl({ workerCount: 1, useWorkers: true });
    await expect(
      q.enqueue({ module: '/no/such/module.mjs', fn: 'x', args: [] }, { worker: true }),
    ).rejects.toBeInstanceOf(Error);
    await q.close();
  });
});

describe('TaskQueueImpl.introspect', () => {
  test('长任务进度与结果', async () => {
    const q = new TaskQueueImpl({ concurrency: 2 });
    const task = q.introspect<number[]>(async (ctx) => {
      const out: number[] = [];
      for (let i = 0; i < 5; i++) {
        if (ctx.isCancelled()) break;
        ctx.report({ stage: 'step', processed: i, total: 5 });
        out.push(i);
        await delay(5);
      }
      return out;
    });
    const progresses: number[] = [];
    task.onProgress((p) => progresses.push(p.processed));
    await expect(task.promise).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(progresses.length).toBeGreaterThan(0);
    await q.close();
  });
});
