/**
 * Builders for the document-query payload. OnBase has no free-text search:
 * a query names its scope (document type(s), a type group, or a saved
 * custom query) and optionally constrains keyword values and the document
 * date. These builders exist so the tool layer states intent and the
 * payload shape lives in one tested place.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type {
  DisplayColumnType,
  OnBaseQueryInformation,
  OnBaseQueryKeyword,
  QueryTargetKind,
} from './types';

export type QueryBuildError = 'NO_QUERY_TARGET';

export interface QueryTarget {
  kind: QueryTargetKind;
  ids: string[];
}

export function buildQueryInformation(options: {
  targets: QueryTarget[];
  keywords?: OnBaseQueryKeyword[];
  documentDateRange?: { start?: string; end?: string };
  maxResults?: number;
  displayColumns?: { keywordTypeId?: string; displayColumnType: DisplayColumnType }[];
}): Result<OnBaseQueryInformation, QueryBuildError> {
  const targets = options.targets.filter((target) => target.ids.length > 0);
  // The API refuses a query without a scope; failing here gives the caller
  // a named error instead of a provider 400.
  if (targets.length === 0) return err('NO_QUERY_TARGET' as const);

  const query: OnBaseQueryInformation = {
    queryType: targets.map((target) => ({ type: target.kind, ids: target.ids })),
  };
  if (options.maxResults !== undefined) query.maxResults = options.maxResults;
  if (options.keywords && options.keywords.length > 0) {
    query.queryKeywordCollection = options.keywords;
  }
  if (options.displayColumns && options.displayColumns.length > 0) {
    query.userDisplayColumns = options.displayColumns;
  }
  if (options.documentDateRange?.start || options.documentDateRange?.end) {
    query.documentDateRangeCollection = [
      {
        ...(options.documentDateRange.start ? { start: options.documentDateRange.start } : {}),
        ...(options.documentDateRange.end ? { end: options.documentDateRange.end } : {}),
      },
    ];
  }
  return ok(query);
}
