// worker 测试用目标模块（真实 worker 线程动态 import 执行）
export function add(a, b) {
  return a + b;
}

export function heavyCompute(n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += i;
  return s;
}

export async function slow(delayMs = 100) {
  await new Promise((r) => setTimeout(r, delayMs));
  return 'done';
}
