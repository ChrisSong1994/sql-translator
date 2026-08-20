import { describe, expect, test, vi } from 'vitest';
import { createTask } from '../../src/types/task.js';

describe('createTask', () => {
  test('完成路径：状态机 pending → running → done', async () => {
    const task = createTask<number>(async (ctx) => {
      ctx.report({ stage: 'working', processed: 1, total: 2 });
      return 42;
    });
    expect(task.status).toBe('pending');
    await expect(task.promise).resolves.toBe(42);
    expect(task.status).toBe('done');
    expect(task.progress.processed).toBe(1);
  });

  test('进度订阅：收到 ≥1 次回调，退订生效', async () => {
    const task = createTask<string>(async (ctx) => {
      ctx.report({ stage: 'a', processed: 1 });
      await new Promise((r) => setTimeout(r, 10));
      ctx.report({ stage: 'b', processed: 2 });
      return 'ok';
    });
    const events: string[] = [];
    const unsub = task.onProgress((p) => events.push(p.stage));
    await task.promise;
    unsub();
    expect(events).toContain('running');
    expect(events).toContain('a');
    expect(events).toContain('b');
  });

  test('取消：promise reject TASK_CANCELLED', async () => {
    const task = createTask<number>(async (ctx) => {
      await new Promise((r) => setTimeout(r, 1000));
      if (ctx.isCancelled()) throw new Error('cancelled inside');
      return 1;
    });
    await task.cancel();
    await expect(task.promise).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    expect(task.status).toBe('cancelled');
  });

  test('执行失败：reject 原始错误，status=failed', async () => {
    const task = createTask<number>(async () => {
      throw new Error('boom');
    });
    await expect(task.promise).rejects.toThrow('boom');
    expect(task.status).toBe('failed');
  });

  test('runner 内感知 AbortSignal', async () => {
    const spy = vi.fn();
    const task = createTask<number>(async (ctx) => {
      ctx.signal.addEventListener('abort', spy);
      await new Promise((r) => setTimeout(r, 50));
      return 1;
    });
    await task.cancel();
    expect(spy).toHaveBeenCalled();
  });
});
