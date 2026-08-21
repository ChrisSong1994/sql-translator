/**
 * MongoDB 驱动（SQL → Query / DML 翻译）
 * SELECT 走 @synatic/noql；DML 走 node-sql-parser + noql WHERE 翻译；
 * 结构检出为长任务（采样分批 + 进度 + 取消）
 */
import { SqlEngineError, wrapError } from '../../errors.js';
import { normalizeSql } from '../../core/sql/normalize.js';
import { detectStatementType, isDmlStatement, hasDmlWhere, countInsertValueRows } from '../../core/sql/statement.js';
import { createTask } from '../../types/task.js';
import type { SqlDriver, PoolHandle } from '../interface.js';
import type { MongodbConfig, SchemaOptions } from '../../types/config.js';
import type {
  ExecResult,
  Field,
  QueryResult,
  RunSqlRequest,
  TestResult,
  WriteResult,
} from '../../types/result.js';
import type { TableSchema } from '../../types/schema.js';
import type { IntrospectTask } from '../../types/task.js';
import type { TransactionHandle } from '../../types/transaction.js';
import type { Document } from 'mongodb';
import { MongoPoolHandle } from './pool.js';
import { translateSelect, translateWhereToMatch, mergeMatch } from './sql-translator.js';
import { translateDml, translateDmlFilter } from './dml-translator.js';
import { analyzeCollection, analysisToTableSchema, analysisToFields, inferFieldsFromRows } from './schema.js';

/** noql 投影（{field: '$field'}）→ Mongo 投影（{field: 1}，排除默认 _id） */
function toMongoProjection(projection: Document | undefined): Document {
  if (!projection) return {};
  const out: Document = {};
  for (const [k, v] of Object.entries(projection)) {
    out[k] = 1;
  }
  if (!('_id' in out)) out._id = 0;
  return out;
}

export class MongoDriver implements SqlDriver {
  readonly dialect = 'mongodb';

  async createPool(config: MongodbConfig): Promise<PoolHandle> {
    if (config.type !== 'mongodb') {
      throw new SqlEngineError('UNSUPPORTED_DIALECT', `mongodb 驱动收到 ${config.type} 配置`);
    }
    return new MongoPoolHandle(config);
  }

  // ==================== 连接测试 ====================

  async testConnection(config: MongodbConfig): Promise<TestResult> {
    let handle: MongoPoolHandle | null = null;
    try {
      handle = new MongoPoolHandle(config);
      const client = await handle.getClient();
      const result = await client.db().command({ ping: 1 });
      if (result.ok !== 1) throw new Error('ping command failed');
      return { success: true, message: 'MongoDB connection test successful' };
    } catch (err) {
      const e = err as Error;
      return { success: false, message: `MongoDB connection test failed: ${e.message}` };
    } finally {
      if (handle) await handle.destroy();
    }
  }

  // ==================== 元信息 ====================

  async getTableList(pool: PoolHandle): Promise<string[]> {
    const db = await (pool as MongoPoolHandle).getDb();
    const collections = await db.listCollections().toArray();
    return collections.map((c) => c.name);
  }

  async getPreviewRows(
    pool: PoolHandle,
    table: string,
    offset: number,
    limit: number,
    whereClause?: string,
  ): Promise<any[]> {
    const db = await (pool as MongoPoolHandle).getDb();
    const query = translateWhereToMatch(whereClause ?? '');
    return db.collection(table).find(query).skip(offset).limit(limit).toArray();
  }

  async getColumns(pool: PoolHandle, table: string): Promise<Field[]> {
    const db = await (pool as MongoPoolHandle).getDb();
    const opts = (pool as MongoPoolHandle).config.introspect ?? {};
    const analysis = await analyzeCollection(db, table, { ...opts, sampleSize: opts.sampleSize ?? 50 }).promise;
    return analysisToFields(analysis);
  }

  async getRowsCount(pool: PoolHandle, table: string, whereClause?: string): Promise<number> {
    const db = await (pool as MongoPoolHandle).getDb();
    const query = translateWhereToMatch(whereClause ?? '');
    return db.collection(table).countDocuments(query);
  }

  // ==================== SQL 执行 ====================

  async runSql(pool: PoolHandle, request: RunSqlRequest): Promise<ExecResult> {
    const handle = pool as MongoPoolHandle;
    return this.runSqlInternal(handle, request, undefined);
  }

  /** 事务/常规共用执行核心（session 可指定为事务会话） */
  runSqlInternal(
    handle: MongoPoolHandle,
    request: RunSqlRequest,
    session?: import('mongodb').ClientSession,
  ): Promise<ExecResult> {
    const sql = normalizeSql(request.sql);
    const type = detectStatementType(sql);
    try {
      if (isDmlStatement(type)) {
        return this.runDml(handle, sql, request.params, type, request.dml, session);
      }
      if (type === 'SELECT') {
        return this.runSelect(handle, sql, request, session);
      }
      throw new SqlEngineError('QUERY_FAILED', `MongoDB 不支持执行 ${type} 语句`);
    } catch (err) {
      if (err instanceof SqlEngineError) return Promise.reject(err);
      return Promise.reject(wrapError('QUERY_FAILED', err));
    }
  }

  /** 事务：session.withTransaction（需要副本集/分片集群，单实例不支持） */
  async withTransaction<T>(
    pool: PoolHandle,
    fn: (tx: TransactionHandle) => Promise<T>,
  ): Promise<T> {
    const handle = pool as MongoPoolHandle;
    const client = await handle.getClient();
    const session = client.startSession();
    const self = this;
    try {
      let result: T;
      await session.withTransaction(async () => {
        const tx: TransactionHandle = {
          runSql: (req) => self.runSqlInternal(handle, req, session),
          query: (sql, params) =>
            self.runSqlInternal(handle, { sql, params }, session) as Promise<QueryResult>,
          execute: (sql, params) =>
            self.runSqlInternal(handle, { sql, params }, session) as Promise<WriteResult>,
          commit: async () => {
            await session.commitTransaction();
          },
          rollback: async () => {
            await session.abortTransaction();
          },
        };
        result = await fn(tx);
      });
      return result!;
    } finally {
      await session.endSession().catch(() => undefined);
    }
  }

  // ---- SELECT（noql：query / aggregate） ----
  private async runSelect(
    handle: MongoPoolHandle,
    sql: string,
    request: RunSqlRequest,
    session?: import('mongodb').ClientSession,
  ): Promise<any> {
    const db = await handle.getDb();
    const parsed = translateSelect(sql);
    const additionalMatch = translateWhereToMatch(request.whereClause ?? '');
    // SQL 自带分页 → 用 noql 解析出的 limit/offset；否则用请求级标准分页
    const sqlHasPagination = !!parsed.limit || !!parsed.offset;
    const standardPagination = !sqlHasPagination;

    const offset = Math.max(Number(parsed.offset ?? request.offset ?? 0), 0);
    const limit = Math.max(Number(parsed.limit ?? request.limit ?? 100), 0);
    const projection = toMongoProjection(parsed.projection);

    if (parsed.type === 'query' && parsed.collection) {
      const query = mergeMatch(parsed.query, additionalMatch);
      const findOpts = session ? { session } : {};
      const docs = await db
        .collection(parsed.collection)
        .find(query, Object.keys(projection).length ? { projection, ...findOpts } : findOpts)
        .skip(offset)
        .limit(limit)
        .toArray();
      const total = standardPagination
        ? await db.collection(parsed.collection).countDocuments(query, session ? { session } : undefined)
        : docs.length;
      return {
        rows: docs,
        fields: inferFieldsFromRows(docs),
        total,
        offset,
        limit,
      };
    }

    if (parsed.type === 'aggregate' && parsed.collections?.[0]) {
      const pipeline = [...(parsed.pipeline ?? [])];
      if (Object.keys(additionalMatch).length) {
        pipeline.push({ $match: additionalMatch });
      }
      const total = standardPagination
        ? await db
            .collection(parsed.collections[0])
            .aggregate([...pipeline, { $count: 'total' }], session ? { session } : undefined)
            .toArray()
            .then((r) => Number(r[0]?.total ?? 0))
        : 0;
      if (standardPagination) {
        pipeline.push({ $skip: offset }, { $limit: limit });
      }
      const docs = await db
        .collection(parsed.collections[0])
        .aggregate(pipeline, session ? { session } : undefined)
        .toArray();
      return {
        rows: docs,
        fields: inferFieldsFromRows(docs),
        total,
        offset,
        limit,
      };
    }

    throw new SqlEngineError('QUERY_FAILED', `无法翻译 SQL: ${sql}`);
  }

  // ---- DML（node-sql-parser + noql WHERE） ----
  private async runDml(
    handle: MongoPoolHandle,
    sql: string,
    params: unknown[] | undefined,
    type: 'INSERT' | 'UPDATE' | 'DELETE',
    dmlOverride?: import('../../types/config.js').DmlOptions,
    session?: import('mongodb').ClientSession,
  ): Promise<WriteResult> {
    const db = await handle.getDb();
    const dml = dmlOverride ?? handle.config.dml ?? {};

    if ((type === 'UPDATE' || type === 'DELETE') && dml.requireWhereForUpdateDelete !== false) {
      if (!hasDmlWhere(sql)) {
        throw new SqlEngineError(
          'DML_BLOCKED',
          `禁止无 WHERE 的 ${type}（config.dml.requireWhereForUpdateDelete 可关闭）`,
        );
      }
    }

    const spec = translateDml(sql, params ?? []);
    const filter = translateDmlFilter(sql);

    if (type === 'INSERT') {
      const documents = spec.documents ?? [];
      if (dml.maxInsertRows && documents.length > dml.maxInsertRows) {
        throw new SqlEngineError(
          'DML_BLOCKED',
          `INSERT 行数 ${documents.length} 超过上限 ${dml.maxInsertRows}`,
        );
      }
      const coll = db.collection(spec.collection);
      const opts = session ? { session } : undefined;
      if (documents.length === 1) {
        const { insertedId } = await coll.insertOne(documents[0]!, opts);
        return { affectedRows: 1, insertId: String(insertedId) };
      }
      const res = await coll.insertMany(documents, opts);
      return { affectedRows: documents.length, insertId: String(Object.values(res.insertedIds)[0]) };
    }

    if (type === 'UPDATE') {
      const res = await db
        .collection(spec.collection)
        .updateMany(filter, spec.updateDoc ?? {}, session ? { session } : undefined);
      return { affectedRows: res.modifiedCount };
    }

    // DELETE
    const res = await db
      .collection(spec.collection)
      .deleteMany(filter, session ? { session } : undefined);
    return { affectedRows: res.deletedCount };
  }

  // ==================== 结构 JSON 检出（长任务） ====================

  getTableSchema(pool: PoolHandle, table: string, opts?: SchemaOptions): Promise<TableSchema> {
    const handle = pool as MongoPoolHandle;
    return handle.getDb().then((db) => {
      const merged: SchemaOptions = {
        ...(handle.config.introspect ?? {}),
        ...(opts ?? {}),
      };
      return analyzeCollection(db, table, merged).promise.then((analysis) =>
        analysisToTableSchema(table, analysis, handle.config.database),
      );
    });
  }

  getAllTableSchemas(pool: PoolHandle, opts?: SchemaOptions): IntrospectTask<TableSchema[]> {
    const handle = pool as MongoPoolHandle;
    const self = this;
    return createTask<TableSchema[]>(async (ctx) => {
      const db = await handle.getDb();
      const collections = await db.listCollections().toArray();
      const total = collections.length;
      const schemas: TableSchema[] = [];
      for (let i = 0; i < collections.length; i++) {
        if (ctx.isCancelled()) break;
        const name = collections[i]!.name;
        ctx.report({ stage: 'introspecting', processed: i, total, message: name });
        try {
          const analysis = await analyzeCollection(db, name, opts ?? handle.config.introspect ?? {}).promise;
          schemas.push(analysisToTableSchema(name, analysis, handle.config.database));
        } catch {
          // 单集合失败不中断
        }
      }
      void self;
      return schemas;
    });
  }
}

export const mongodbDriver = new MongoDriver();
