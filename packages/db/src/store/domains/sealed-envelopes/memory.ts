import { compareAsc, like, orderBy, page, type OrderTerm } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { SealedEnvelopeStore } from './types';

type Fields = Record<string, unknown>;

export function memorySealedEnvelopes(tables: MemoryTables): SealedEnvelopeStore {
  /** A query value as the column reads it (a uuid lower-cased, or refused when malformed). */
  const paramOf = (table: string, column: string, value: string): unknown => value;

  return {
    async pageNotLike(target, notLike, after, limit) {
      const last = after?.map((value, i) => paramOf(target.table, target.idColumns[i], value));
      const past = (row: Fields): boolean => {
        if (!last) return true;
        for (let i = 0; i < target.idColumns.length; i += 1) {
          const result = compareAsc(row[target.idColumns[i]], last[i]);
          if (result !== 0) return result > 0;
        }
        return false;
      };
      const rows = tables.selectWhere(target.table, (row) => {
        const value = row[target.column];
        return typeof value === 'string' && !like(value, notLike, true) && past(row);
      });
      const sorted = orderBy(
        rows,
        ...target.idColumns.map((column): OrderTerm<Fields> => [(r) => r[column]])
      );
      return page(sorted, limit).map((row) => ({
        id: target.idColumns.map((column) => String(row[column] ?? '')),
        value: String(row[target.column]),
      }));
    },
    async replaceIfUnchanged(target, id, stored, next) {
      const wanted = target.idColumns.map((column, i) =>
        paramOf(target.table, column, id[i] ?? '')
      );
      return tables.updateWhere(
        target.table,
        (row) =>
          target.idColumns.every((column, i) => row[column] === wanted[i]) &&
          row[target.column] === stored,
        { [target.column]: next }
      );
    },
  };
}
