import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { DB } from '../../../db.types';
import type { SealedEnvelopeStore } from './types';

type Row = Record<string, string | null>;

export function postgresSealedEnvelopes(db: () => Kysely<DB>): SealedEnvelopeStore {
  return {
    async pageNotLike(target, notLike, after, limit) {
      const ids = sql.join(target.idColumns.map((column) => sql.ref(column)));
      // Keyset pagination on the key columns: `(a, b) > (last_a, last_b)`.
      const past: RawBuilder<unknown> =
        after === null
          ? sql`true`
          : sql`(${ids}) > (${sql.join(after.map((value) => sql.val(value)))})`;
      const page = await sql<Row>`
        select ${ids}, ${sql.ref(target.column)} as value
        from ${sql.table(target.table)}
        where ${sql.ref(target.column)} is not null
          and ${sql.ref(target.column)} not like ${notLike}
          and ${past}
        order by ${ids}
        limit ${limit}
      `.execute(db());
      return page.rows.map((row) => ({
        id: target.idColumns.map((column) => row[column] ?? ''),
        value: row.value ?? '',
      }));
    },
    async replaceIfUnchanged(target, id, stored, next) {
      const match = sql.join(
        target.idColumns.map((column, i) => sql`${sql.ref(column)} = ${id[i] ?? ''}`),
        sql` and `
      );
      const result = await sql`
        update ${sql.table(target.table)}
        set ${sql.ref(target.column)} = ${next}
        where ${match} and ${sql.ref(target.column)} = ${stored}
      `.execute(db());
      return Number(result.numAffectedRows ?? 0);
    },
  };
}
