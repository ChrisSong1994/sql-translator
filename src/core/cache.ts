/**
 * TTL + LRU 缓存（查询结果缓存用）
 */
export interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  /** 最近使用时间戳（LRU 淘汰） */
  lastUsedAt: number;
}

export class TtlCache<K, V> {
  private map = new Map<K, CacheEntry<V>>();

  constructor(
    private ttlMs: number,
    private maxEntries = 1000,
  ) {}

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    entry.lastUsedAt = Date.now();
    return entry.value;
  }

  set(key: K, value: V): void {
    const now = Date.now();
    if (this.map.has(key)) {
      this.map.delete(key); // 保持插入序 = 使用序（LRU）
    }
    this.map.set(key, { value, expiresAt: now + this.ttlMs, lastUsedAt: now });
    // 容量超限：淘汰最旧（Map 插入序第一个）
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** 查询缓存 key：config 指纹 + 请求参数序列化 */
export function queryCacheKey(
  fingerprint: string,
  sql: string,
  request: { offset?: number; limit?: number; whereClause?: string; params?: unknown[] },
): string {
  const parts = [
    fingerprint,
    String(sql),
    String(request.offset ?? ''),
    String(request.limit ?? ''),
    String(request.whereClause ?? ''),
  ];
  if (request.params?.length) {
    parts.push(JSON.stringify(request.params));
  }
  return parts.join('|');
}
