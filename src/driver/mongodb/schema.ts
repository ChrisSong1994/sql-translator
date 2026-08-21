/**
 * MongoDB 集合结构采样（迁移自 WizBuild mongodb-analyzer.ts）
 * 长任务形态：分批 cursor + 进度上报 + 取消（cursor.close）
 */
import type { Db, Document } from 'mongodb';
import type { SchemaOptions } from '../../types/config.js';
import type { IntrospectTask } from '../../types/task.js';
import { createTask } from '../../types/task.js';
import type { ColumnSchema, TableSchema } from '../../types/schema.js';

type JsonType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'objectid'
  | 'array'
  | 'object'
  | 'null'
  | 'unknown';

interface NodeStats {
  types: Set<JsonType>;
  count: number;
  nullCount: number;
  properties?: Map<string, NodeStats>;
  items?: NodeStats;
}

/** 值类型检测（含 ObjectId/Buffer/Date） */
function detectType(v: any): JsonType {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'object') {
    // ObjectId / Buffer / 其他 BSON 类型
    const ctor = v.constructor?.name;
    if (ctor === 'ObjectId') return 'objectid';
    if (ctor === 'Binary') return 'object';
    if (ctor === 'Long' || ctor === 'Int32' || ctor === 'Double' || ctor === 'Decimal128')
      return 'number';
    return 'object';
  }
  return 'unknown';
}

function ensureChild(parent: NodeStats, key: string): NodeStats {
  if (!parent.properties) parent.properties = new Map<string, NodeStats>();
  let child = parent.properties.get(key);
  if (!child) {
    child = { types: new Set<JsonType>(), count: 0, nullCount: 0 };
    parent.properties.set(key, child);
  }
  return child;
}

function ensureItems(parent: NodeStats): NodeStats {
  if (!parent.items) parent.items = { types: new Set<JsonType>(), count: 0, nullCount: 0 };
  return parent.items;
}

function mergeNode(target: NodeStats, source: NodeStats): void {
  source.types.forEach((t) => target.types.add(t));
  target.count += source.count;
  target.nullCount += source.nullCount;
  if (source.properties) {
    for (const [key, child] of source.properties) {
      mergeNode(ensureChild(target, key), child);
    }
  }
  if (source.items) {
    mergeNode(ensureItems(target), source.items);
  }
}

function sampleValue(node: NodeStats, v: any): void {
  node.count++;
  const type = detectType(v);
  node.types.add(type);
  if (type === 'null') {
    node.nullCount++;
    return;
  }
  if (type === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      sampleValue(ensureChild(node, k), val);
    }
  } else if (type === 'array') {
    for (const item of v as unknown[]) {
      sampleValue(ensureItems(node), item);
    }
  }
}

export interface MongoSchemaAnalysis {
  collectionName: string;
  analyzedDocuments: number;
  schema: {
    types: JsonType[];
    required: boolean;
    nullable: boolean;
    properties?: Record<string, any>;
    items?: any;
  };
}

/** 把 NodeStats 转成可序列化 schema */
function nodeToSchema(node: NodeStats): any {
  const types = [...node.types];
  const result: any = {
    types,
    required: node.count > 0 && node.nullCount === 0,
    nullable: node.nullCount > 0,
  };
  if (node.properties) {
    const props: Record<string, any> = {};
    for (const [key, child] of node.properties) {
      props[key] = nodeToSchema(child);
    }
    result.properties = props;
  }
  if (node.items) {
    result.items = nodeToSchema(node.items);
  }
  return result;
}

/** 采样分析集合结构（长任务） */
export function analyzeCollection(
  db: Db,
  collectionName: string,
  opts: SchemaOptions = {},
): IntrospectTask<MongoSchemaAnalysis> {
  return createTask<MongoSchemaAnalysis>(async (ctx) => {
    const sampleSize = opts.sampleSize ?? 100;
    const batchSize = Math.min(Math.max(opts.sampleSize ?? 50, 1), 1000);

    const coll = db.collection(collectionName);
    const root: NodeStats = { types: new Set<JsonType>(), count: 0, nullCount: 0 };
    const isAll = opts.analyzeAll === true;
    const limit = isAll ? 0 : sampleSize;

    // 全量模式先拿一个估计总量用于进度
    let total: number | undefined;
    if (isAll) {
      try {
        total = await coll.estimatedDocumentCount();
      } catch {
        total = undefined;
      }
    } else {
      total = sampleSize;
    }

    const cursor = coll.find({}, { batchSize }).limit(limit);
    const abortHandler = () => {
      void cursor.close().catch(() => undefined);
    };
    ctx.signal.addEventListener('abort', abortHandler, { once: true });

    try {
      let processed = 0;
      while (await cursor.hasNext()) {
        if (ctx.isCancelled()) break;
        const doc = await cursor.next();
        if (doc) {
          processed++;
          sampleValue(root, doc);
        }
        if (processed % batchSize === 0 || processed === total) {
          ctx.report({ stage: 'sampling', processed, total, message: collectionName });
        }
      }
      if (!ctx.isCancelled()) {
        ctx.report({ stage: 'analyzing', processed, total });
      }
      const schema = nodeToSchema(root);
      const required = schema.required !== false;
      schema.required = required;
      return {
        collectionName,
        analyzedDocuments: processed,
        schema,
      };
    } finally {
      ctx.signal.removeEventListener('abort', abortHandler);
      await cursor.close().catch(() => undefined);
    }
  });
}

/** display_type 映射 */
function typeToDisplay(type: JsonType): string {
  switch (type) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    case 'objectid':
      return 'string';
    case 'null':
      return 'string';
    default:
      return 'string';
  }
}

/** 采样分析 → TableSchema（columns + raw.properties 递归结构） */
export function analysisToTableSchema(
  collectionName: string,
  analysis: MongoSchemaAnalysis,
  dbName?: string,
): TableSchema {
  const properties: Record<string, any> = analysis.schema.properties ?? {};
  const columns: ColumnSchema[] = Object.entries(properties).map(([name, prop], i) => {
    const types: JsonType[] = prop.types ?? ['string'];
    const primary = types[0] ?? 'string';
    return {
      name,
      type: primary,
      nullable: prop.nullable !== false,
      comment: undefined,
      primaryKey: false,
      autoIncrement: false,
      ordinal: i + 1,
    };
  });
  return {
    name: collectionName,
    schema: dbName,
    kind: 'collection',
    comment: undefined,
    columns,
    indexes: undefined,
    foreignKeys: undefined,
    ddl: undefined,
    raw: { properties, analyzedDocuments: analysis.analyzedDocuments },
  };
}

/** 采样分析 → Field[]（getColumns 用） */
export function analysisToFields(analysis: MongoSchemaAnalysis) {
  const properties: Record<string, any> = analysis.schema.properties ?? {};
  return Object.entries(properties).map(([name, prop]) => {
    const types: JsonType[] = prop.types ?? ['string'];
    const primary = types[0] ?? 'string';
    return {
      field_name: name,
      custom_name: name,
      field_desc: '',
      field_type: primary,
      display_type: typeToDisplay(primary),
      is_primary: 0 as const,
    };
  });
}

/** 从行推断字段（查询结果无协议元数据时用） */
export function inferFieldsFromRows(rows: Document[]): any[] {
  if (!rows.length) return [];
  const first = rows[0] ?? {};
  return Object.keys(first).map((key) => {
    const value = first[key];
    const type = detectType(value);
    return {
      field_name: key,
      custom_name: key,
      field_desc: '',
      field_type: type,
      display_type: typeToDisplay(type),
      is_primary: 0 as const,
    };
  });
}
