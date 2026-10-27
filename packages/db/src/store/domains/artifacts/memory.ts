import { compareAsc, like, orderBy, page } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import { artifactFromRow, likePattern } from './record';
import type { ArtifactStore, LibraryFilter } from './types';

type Artifact = Row<'artifacts'>;

/**
 * The memory store's stand-in for `search_vector @@
 * websearch_to_tsquery('english', query)`: every word of the query
 * appears, case-insensitively, as a whole word of the digest (summary and
 * keywords) of a row that has a search vector. Postgres also stems words,
 * drops stop words and reads quotes, `or` and `-`; the differential
 * scenarios search only with plain words whose stems are themselves,
 * where the two agree.
 */
function digestMatches(row: Artifact, query: string): boolean {
  if (row.search_vector === null) return false;
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return false;
  const digest = new Set(
    [row.summary ?? '', ...row.keywords]
      .join(' ')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
  return words.every((word) => digest.has(word));
}

export function memoryArtifacts(tables: MemoryTables): ArtifactStore {
  const artifactId = (value: string) => tables.param('artifacts', 'id', value);
  const oldestFirst = (rows: Artifact[]) => orderBy(rows, [(r) => r.created_at], [(r) => r.id]);
  const withReference = (reference: Row<'artifact_references'>) => {
    const artifact = tables.first('artifacts', (a) => a.id === reference.artifact_id);
    return artifact
      ? {
          ...artifactFromRow(artifact),
          referenceId: reference.id,
          mode: reference.mode,
          addedBy: reference.added_by,
        }
      : null;
  };
  const admits = (filter: LibraryFilter) => {
    const shared = new Set(filter.sharedIds.map(artifactId));
    const project = filter.projectId
      ? tables.param('artifact_references', 'project_id', filter.projectId)
      : null;
    const inProject = project
      ? new Set(
          tables
            .select('artifact_references', (r) => r.project_id === project)
            .map((r) => r.artifact_id)
        )
      : null;
    const patterns = filter.terms.map(likePattern);
    return (row: Artifact): boolean => {
      const owned = row.owner_subject === filter.viewerSubject;
      const isShared = shared.has(row.id);
      const kind =
        filter.show === 'all'
          ? owned || isShared
          : filter.show === 'uploaded'
            ? owned && row.origin === 'upload'
            : filter.show === 'generated'
              ? owned && row.origin === 'model'
              : isShared;
      if (!kind) return false;
      if (inProject && !inProject.has(row.id)) return false;
      if (patterns.length > 0) {
        const byName = patterns.every((pattern) => like(row.filename, pattern));
        if (!byName && !digestMatches(row, filter.query)) return false;
      }
      return true;
    };
  };

  return {
    async get(id) {
      const wanted = artifactId(id);
      const row = tables.first('artifacts', (r) => r.id === wanted);
      return row ? artifactFromRow(row) : null;
    },
    async getMany(ids) {
      if (ids.length === 0) return [];
      const wanted = new Set(ids.map(artifactId));
      return oldestFirst(tables.select('artifacts', (r) => wanted.has(r.id))).map(artifactFromRow);
    },
    async listByChat(chatId, options = {}) {
      const chat = tables.param('artifacts', 'chat_id', chatId);
      return oldestFirst(
        tables.select(
          'artifacts',
          (r) => r.chat_id === chat && (!options.origin || r.origin === options.origin)
        )
      ).map(artifactFromRow);
    },
    async findInChat(input) {
      if (!input.id && !input.filename) return null;
      const chat = tables.param('artifacts', 'chat_id', input.chatId);
      const id = input.id ? artifactId(input.id) : null;
      const [row] = orderBy(
        tables.select(
          'artifacts',
          (r) =>
            r.chat_id === chat &&
            r.owner_subject === input.ownerSubject &&
            (id !== null ? r.id === id : r.filename === (input.filename ?? ''))
        ),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id]
      );
      return row ? artifactFromRow(row) : null;
    },
    async getText(id) {
      const wanted = artifactId(id);
      return tables.first('artifacts', (r) => r.id === wanted)?.extracted_text ?? null;
    },
    async textLengths(ids) {
      if (ids.length === 0) return [];
      const wanted = new Set(ids.map(artifactId));
      return orderBy(
        tables.select('artifacts', (r) => wanted.has(r.id)),
        [(r) => r.id]
      ).map((r) => ({ id: r.id, chars: r.extracted_text ? [...r.extracted_text].length : 0 }));
    },
    async listForProject(projectId) {
      const project = tables.param('artifact_references', 'project_id', projectId);
      return orderBy(
        tables.select('artifact_references', (r) => r.project_id === project),
        [(r) => r.created_at],
        [(r) => r.id]
      ).flatMap((reference) => {
        const row = withReference(reference);
        return row ? [row] : [];
      });
    },
    async getForProject(projectId, id) {
      const project = tables.param('artifact_references', 'project_id', projectId);
      const wanted = artifactId(id);
      const reference = tables.first(
        'artifact_references',
        (r) => r.project_id === project && r.artifact_id === wanted
      );
      return reference ? withReference(reference) : null;
    },
    async listReferences(id) {
      const wanted = artifactId(id);
      return orderBy(
        tables.select('artifact_references', (r) => r.artifact_id === wanted),
        [(r) => r.created_at],
        [(r) => r.id]
      ).map((r) => ({
        referenceId: r.id,
        projectId: r.project_id,
        mode: r.mode,
        addedBy: r.added_by,
      }));
    },
    async referenceCounts(ids) {
      if (ids.length === 0) return [];
      const wanted = new Set(ids.map(artifactId));
      const counts = new Map<string, number>();
      for (const r of tables.select('artifact_references', (r) => wanted.has(r.artifact_id))) {
        counts.set(r.artifact_id, (counts.get(r.artifact_id) ?? 0) + 1);
      }
      return [...counts]
        .sort(([a], [b]) => compareAsc(a, b))
        .map(([artifactId, count]) => ({ artifactId, count }));
    },
    async projectsUsing(ids) {
      if (ids.length === 0) return [];
      const wanted = new Set(ids.map(artifactId));
      return orderBy(
        tables.select('artifact_references', (r) => wanted.has(r.artifact_id)),
        [(r) => r.created_at],
        [(r) => r.id]
      ).flatMap((r) => {
        const project = tables.first('chat_projects', (p) => p.id === r.project_id);
        return project
          ? [
              {
                artifactId: r.artifact_id,
                mode: r.mode,
                projectId: project.id,
                name: project.name,
                kind: project.kind,
              },
            ]
          : [];
      });
    },
    async listOwned(ownerSubject) {
      return orderBy(
        tables.select('artifacts', (r) => r.owner_subject === ownerSubject),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id]
      ).map(artifactFromRow);
    },
    async ocrSamples(limit) {
      // ORDER BY … DESC puts nulls first, as Postgres does.
      return page(
        orderBy(
          tables.select('artifacts', (r) => r.ocr_millis !== null),
          [(r) => r.ocr_finished_at, 'desc'],
          [(r) => r.id]
        ),
        limit
      ).map((r) => ({ sizeBytes: Number(r.size_bytes), millis: r.ocr_millis ?? 0 }));
    },
    async libraryCount(filter) {
      return tables.select('artifacts', admits(filter)).length;
    },
    async libraryRows(filter, { limit, offset }) {
      return page(
        orderBy(
          tables.select('artifacts', admits(filter)),
          [(r) => r.owner_subject === filter.viewerSubject, 'desc'],
          [(r) => r.created_at, 'desc'],
          [(r) => r.id]
        ),
        limit,
        offset
      ).map(artifactFromRow);
    },
    async libraryPosition(filter, focusId) {
      const wanted = artifactId(focusId);
      const rows = tables.select('artifacts', admits(filter));
      const focused = rows.find((r) => r.id === wanted);
      if (!focused) return null;
      const focusOwned = focused.owner_subject === filter.viewerSubject;
      const newer = (r: Artifact) => r.created_at.getTime() > focused.created_at.getTime();
      return rows.filter((r) => {
        const owned = r.owner_subject === filter.viewerSubject;
        return focusOwned ? owned && newer(r) : owned || newer(r);
      }).length;
    },
    async ownedTotals(ownerSubject) {
      const rows = tables.select('artifacts', (r) => r.owner_subject === ownerSubject);
      return {
        count: rows.length,
        bytes: rows.reduce((sum, r) => sum + Number(r.size_bytes), 0),
      };
    },
    async countExisting(ids) {
      if (ids.length === 0) return 0;
      const wanted = new Set(ids.map(artifactId));
      return tables.select('artifacts', (r) => wanted.has(r.id)).length;
    },
  };
}
