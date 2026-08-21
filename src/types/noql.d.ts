/**
 * @synatic/noql 环境声明（CJS 包无自带类型）
 */
declare module '@synatic/noql' {
  import type { Document } from 'mongodb';

  export interface NoqlResult {
    type: 'query' | 'aggregate';
    collection?: string;
    collections?: string[];
    query?: Document;
    projection?: Document;
    pipeline?: Document[];
    limit?: number;
    offset?: number;
  }

  export function parseSQL(sql: string): NoqlResult;

  const parseSQLFn: typeof parseSQL;
  export default parseSQLFn;
}
