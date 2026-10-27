import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { ARTIFACT_COLUMNS, artifactFromRow, likePattern } from './record';
import type { ArtifactStore, LibraryFilter } from './types';

const REFERENCE_COLUMNS = [
  'r.id as reference_id',
  'r.mode',
  'r.added_by',
  ...ARTIFACT_COLUMNS.map((column) => `a.${column}` as const),
] as const;

/** The rows a library filter admits (owned vs shared told apart by owner). */
function filterWhere(eb: ExpressionBuilder<DB, 'artifacts'>, filter: LibraryFilter) {
  const owned = eb('owner_subject', '=', filter.viewerSubject);
  const shared = filter.sharedIds.length > 0 ? eb('id', 'in', filter.sharedIds) : eb.val(false);
  const conditions = [];
  switch (filter.show) {
    case 'all':
      conditions.push(eb.or([owned, shared]));
      break;
    case 'uploaded':
      conditions.push(eb.and([owned, eb('origin', '=', 'upload')]));
      break;
    case 'generated':
      conditions.push(eb.and([owned, eb('origin', '=', 'model')]));
      break;
    case 'shared':
      conditions.push(shared);
      break;
  }
  if (filter.projectId) {
    conditions.push(
      eb(
        'id',
        'in',
        eb
          .selectFrom('artifact_references')
          .select('artifact_id')
          .where('project_id', '=', filter.projectId)
      )
    );
  }
  if (filter.terms.length > 0) {
    const byName = eb.and(filter.terms.map((term) => eb('filename', 'ilike', likePattern(term))));
    const byDigest = sql<boolean>`search_vector @@ websearch_to_tsquery('english', ${filter.query})`;
    conditions.push(eb.or([byName, byDigest]));
  }
  return eb.and(conditions);
}

export function postgresArtifacts(db: () => Kysely<DB>): ArtifactStore {
  return {
    async get(artifactId) {
      const row = await db()
        .selectFrom('artifacts')
        .select(ARTIFACT_COLUMNS)
        .where('id', '=', artifactId)
        .executeTakeFirst();
      return row ? artifactFromRow(row) : null;
    },
    async getMany(artifactIds) {
      if (artifactIds.length === 0) return [];
      const rows = await db()
        .selectFrom('artifacts')
        .select(ARTIFACT_COLUMNS)
        .where('id', 'in', artifactIds)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return rows.map(artifactFromRow);
    },
    async listByChat(chatId, options = {}) {
      let query = db()
        .selectFrom('artifacts')
        .select(ARTIFACT_COLUMNS)
        .where('chat_id', '=', chatId);
      if (options.origin) query = query.where('origin', '=', options.origin);
      const rows = await query.orderBy('created_at', 'asc').orderBy('id').execute();
      return rows.map(artifactFromRow);
    },
    async findInChat(input) {
      if (!input.id && !input.filename) return null;
      let query = db()
        .selectFrom('artifacts')
        .select(ARTIFACT_COLUMNS)
        .where('chat_id', '=', input.chatId)
        .where('owner_subject', '=', input.ownerSubject);
      query = input.id
        ? query.where('id', '=', input.id)
        : query.where('filename', '=', input.filename ?? '');
      const row = await query
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(1)
        .executeTakeFirst();
      return row ? artifactFromRow(row) : null;
    },
    async getText(artifactId) {
      const row = await db()
        .selectFrom('artifacts')
        .select('extracted_text')
        .where('id', '=', artifactId)
        .executeTakeFirst();
      return row?.extracted_text ?? null;
    },
    async textLengths(artifactIds) {
      if (artifactIds.length === 0) return [];
      const rows = await db()
        .selectFrom('artifacts')
        .select((eb) => [
          'id',
          eb.fn.coalesce(eb.fn('length', ['extracted_text']), sql<number>`0`).as('chars'),
        ])
        .where('id', 'in', artifactIds)
        .orderBy('id')
        .execute();
      return rows.map((row) => ({ id: row.id, chars: Number(row.chars) }));
    },
    async alwaysTextLengths(projectId, exceptId) {
      const rows = await db()
        .selectFrom('artifact_references as r')
        .innerJoin('artifacts as a', 'a.id', 'r.artifact_id')
        .select((eb) => [
          'a.id',
          eb.fn.coalesce(eb.fn('length', ['a.extracted_text']), sql<number>`0`).as('chars'),
        ])
        .where('r.project_id', '=', projectId)
        .where('r.mode', '=', 'always')
        .where('a.id', '!=', exceptId ?? '00000000-0000-0000-0000-000000000000')
        .orderBy('a.id')
        .execute();
      return rows.map((row) => ({ id: row.id, chars: Number(row.chars) }));
    },
    async listForProject(projectId) {
      const rows = await db()
        .selectFrom('artifact_references as r')
        .innerJoin('artifacts as a', 'a.id', 'r.artifact_id')
        .select(REFERENCE_COLUMNS)
        .where('r.project_id', '=', projectId)
        .orderBy('r.created_at', 'asc')
        .orderBy('r.id')
        .execute();
      return rows.map((row) => ({
        ...artifactFromRow(row),
        referenceId: row.reference_id,
        mode: row.mode,
        addedBy: row.added_by,
      }));
    },
    async getForProject(projectId, artifactId) {
      const row = await db()
        .selectFrom('artifact_references as r')
        .innerJoin('artifacts as a', 'a.id', 'r.artifact_id')
        .select(REFERENCE_COLUMNS)
        .where('r.project_id', '=', projectId)
        .where('r.artifact_id', '=', artifactId)
        .executeTakeFirst();
      return row
        ? {
            ...artifactFromRow(row),
            referenceId: row.reference_id,
            mode: row.mode,
            addedBy: row.added_by,
          }
        : null;
    },
    async listReferences(artifactId) {
      const rows = await db()
        .selectFrom('artifact_references')
        .select(['id', 'project_id', 'mode', 'added_by'])
        .where('artifact_id', '=', artifactId)
        .orderBy('created_at', 'asc')
        .orderBy('id')
        .execute();
      return rows.map((row) => ({
        referenceId: row.id,
        projectId: row.project_id,
        mode: row.mode,
        addedBy: row.added_by,
      }));
    },
    async referenceCounts(artifactIds) {
      if (artifactIds.length === 0) return [];
      const rows = await db()
        .selectFrom('artifact_references')
        .select((eb) => ['artifact_id', eb.fn.count<string>('id').as('count')])
        .where('artifact_id', 'in', artifactIds)
        .groupBy('artifact_id')
        .orderBy('artifact_id')
        .execute();
      return rows.map((row) => ({ artifactId: row.artifact_id, count: Number(row.count) }));
    },
    async projectsUsing(artifactIds) {
      if (artifactIds.length === 0) return [];
      const rows = await db()
        .selectFrom('artifact_references as r')
        .innerJoin('chat_projects as p', 'p.id', 'r.project_id')
        .select(['r.artifact_id', 'r.mode', 'p.id', 'p.name', 'p.kind'])
        .where('r.artifact_id', 'in', artifactIds)
        .orderBy('r.created_at', 'asc')
        .orderBy('r.id')
        .execute();
      return rows.map((row) => ({
        artifactId: row.artifact_id,
        mode: row.mode,
        projectId: row.id,
        name: row.name,
        kind: row.kind,
      }));
    },
    async listOwned(ownerSubject) {
      const rows = await db()
        .selectFrom('artifacts')
        .select(ARTIFACT_COLUMNS)
        .where('owner_subject', '=', ownerSubject)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .execute();
      return rows.map(artifactFromRow);
    },
    async ocrSamples(limit) {
      const rows = await db()
        .selectFrom('artifacts')
        .select(['size_bytes', 'ocr_millis'])
        .where('ocr_millis', 'is not', null)
        .orderBy('ocr_finished_at', 'desc')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        sizeBytes: Number(row.size_bytes),
        millis: row.ocr_millis ?? 0,
      }));
    },
    async libraryCount(filter) {
      const row = await db()
        .selectFrom('artifacts')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where((eb) => filterWhere(eb, filter))
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },
    async libraryRows(filter, { limit, offset }) {
      // The viewer's own artifacts first. Named once, as the query this
      // replaced did: it orders, it doesn't repeat a SELECT expression
      // (src/group-by-parameter.test.ts).
      const ownedFirst = sql`(owner_subject = ${filter.viewerSubject}) desc`;
      const rows = await db()
        .selectFrom('artifacts')
        .select(ARTIFACT_COLUMNS)
        .where((eb) => filterWhere(eb, filter))
        .orderBy(ownedFirst)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'asc')
        .limit(limit)
        .offset(offset)
        .execute();
      return rows.map(artifactFromRow);
    },
    async libraryPosition(filter, focusId) {
      const focused = await db()
        .selectFrom('artifacts')
        .select(['owner_subject', 'created_at'])
        .where('id', '=', focusId)
        .where((eb) => filterWhere(eb, filter))
        .executeTakeFirst();
      if (!focused) return null;
      const focusOwned = focused.owner_subject === filter.viewerSubject;
      const before = await db()
        .selectFrom('artifacts')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where((eb) => filterWhere(eb, filter))
        .where((eb) =>
          focusOwned
            ? eb.and([
                eb('owner_subject', '=', filter.viewerSubject),
                eb('created_at', '>', focused.created_at),
              ])
            : eb.or([
                eb('owner_subject', '=', filter.viewerSubject),
                eb('created_at', '>', focused.created_at),
              ])
        )
        .executeTakeFirstOrThrow();
      return Number(before.count);
    },
    async ownedTotals(ownerSubject) {
      const row = await db()
        .selectFrom('artifacts')
        .select((eb) => [
          eb.fn.countAll<string>().as('count'),
          eb.fn.coalesce(eb.fn.sum<string>('size_bytes'), sql<string>`0`).as('bytes'),
        ])
        .where('owner_subject', '=', ownerSubject)
        .executeTakeFirstOrThrow();
      return { count: Number(row.count), bytes: Number(row.bytes) };
    },
    async countExisting(artifactIds) {
      if (artifactIds.length === 0) return 0;
      const row = await db()
        .selectFrom('artifacts')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('id', 'in', artifactIds)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },
  };
}
