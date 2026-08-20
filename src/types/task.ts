/**
 * 长任务类型（进度上报 / 取消 / 状态机）
 */

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TaskProgress {
  /** 阶段名：如 'sampling' | 'analyzing' | 'building' */
  stage: string;
  /** 已处理数（已采样文档 / 已导出表数） */
  processed: number;
  /** 总量（未知时省略） */
  total?: number;
  message?: string;
}

/** 长任务执行上下文（runner 内部使用） */
export interface IntrospectContext {
  /** 上报进度 */
  report(progress: TaskProgress): void;
  /** 取消信号：取消时触发 abort */
  signal: AbortSignal;
  /** 是否已被取消 */
  isCancelled(): boolean;
}

/** 长任务执行器 */
export type IntrospectRunner<T> = (ctx: IntrospectContext) => Promise<T>;

export interface IntrospectTask<T> {
  readonly id: string;
  readonly status: TaskStatus;
  readonly progress: TaskProgress;
  /** 等待完成；失败 reject SqlEngineError(TASK_CANCELLED / 其他) */
  readonly promise: Promise<T>;
  /** 订阅进度，返回退订函数 */
  onProgress(cb: (p: TaskProgress) => void): () => void;
  /** 取消；promise reject TASK_CANCELLED */
  cancel(): Promise<void>;
}

let taskSeq = 0;

/**
 * 创建长任务
 * @param runner 执行器（内部通过 ctx.report 上报进度、ctx.signal 感知取消）
 */
export function createTask<T>(runner: IntrospectRunner<T>): IntrospectTask<T> {
  const id = `task-${++taskSeq}-${Date.now().toString(36)}`;
  let status: TaskStatus = 'pending';
  let progress: TaskProgress = { stage: 'pending', processed: 0 };
  const listeners = new Set<(p: TaskProgress) => void>();
  let cancelRequested = false;

  const abort = new AbortController();

  const emit = (p: TaskProgress) => {
    progress = p;
    for (const cb of listeners) cb(p);
  };

  const promise = new Promise<T>((resolve, reject) => {
    const run = async () => {
      status = 'running';
      emit({ ...progress, stage: 'running' });
      try {
        const result = await runner({
          report: (p) => {
            if (!cancelRequested) emit(p);
          },
          signal: abort.signal,
          isCancelled: () => cancelRequested,
        });
        if (cancelRequested) {
          status = 'cancelled';
          emit({ ...progress, stage: 'cancelled' });
          reject(newTaskCancelledError(id));
          return;
        }
        status = 'done';
        emit({ ...progress, stage: 'done' });
        resolve(result);
      } catch (err) {
        if (cancelRequested || abort.signal.aborted) {
          status = 'cancelled';
          emit({ ...progress, stage: 'cancelled' });
          reject(newTaskCancelledError(id));
        } else {
          status = 'failed';
          emit({ ...progress, stage: 'failed' });
          reject(err);
        }
      }
    };
    // 延迟到微任务执行，保证 pending 状态可观测（订阅者先注册再运行）
    void Promise.resolve().then(run);
  });

  const cancel = async (): Promise<void> => {
    if (status === 'done' || status === 'failed' || status === 'cancelled') return;
    cancelRequested = true;
    // 延迟到微任务再触发 abort，让 runner 先完成监听器注册
    queueMicrotask(() => abort.abort());
    status = 'cancelled';
    emit({ ...progress, stage: 'cancelled' });
    // 等待 runner 收尾（signal 触发后 runner 应尽快返回）
    await promise.catch(() => undefined);
  };

  return {
    id,
    get status() {
      return status;
    },
    get progress() {
      return progress;
    },
    promise,
    onProgress(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    cancel,
  };
}

/** 构造 TASK_CANCELLED 错误（避免循环依赖 errors.ts，直接导出构造器） */
export function newTaskCancelledError(id: string): Error {
  const err = new Error(`Task ${id} cancelled`) as Error & { code: string };
  err.code = 'TASK_CANCELLED';
  return err;
}

/**
 * 任务包装：inner 任务异步创建（如先等连接池就绪）时，保证进度事件不丢失
 * - 事件先入缓冲，订阅时立即重放已缓冲进度，再实时转发
 */
export function wrapTask<T>(createInner: () => Promise<IntrospectTask<T>>): IntrospectTask<T> {
  let inner: IntrospectTask<T> | null = null;
  let cancelled = false;
  const buffer: TaskProgress[] = [];
  const live = new Set<(p: TaskProgress) => void>();

  const push = (p: TaskProgress) => {
    buffer.push(p);
    for (const cb of live) cb(p);
  };

  const promise = createInner().then((task) => {
    inner = task;
    const unsub = task.onProgress(push);
    task.promise.finally(() => unsub());
    // 快照当前进度（含已完成状态），确保订阅者能拿到
    push(task.progress);
    return task.promise;
  });

  return {
    id: `wrapped-${Date.now().toString(36)}`,
    get status() {
      return inner?.status ?? (cancelled ? 'cancelled' : 'pending');
    },
    get progress() {
      return inner?.progress ?? { stage: 'pending', processed: 0 };
    },
    promise,
    onProgress(cb) {
      for (const p of buffer) cb(p);
      live.add(cb);
      return () => live.delete(cb);
    },
    cancel() {
      cancelled = true;
      return inner?.cancel() ?? Promise.resolve();
    },
  };
}
