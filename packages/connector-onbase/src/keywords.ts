/**
 * Keyword-type name resolution and keyword merging — the two pieces of
 * OnBase-specific logic dangerous enough to want tests.
 *
 * Resolution exists because the query API speaks numeric type ids while a
 * caller holds words ("Vendor", "Invoice Amount"); the tools resolve names
 * so the model never has to run a lookup errand first (the Jira
 * custom-field answer, applied here).
 *
 * Merging exists because `PUT /documents/{id}/keywords` REPLACES every
 * keyword value on the document. A caller that sent only the field it
 * wanted to change would silently erase the rest — and the API reports
 * success either way. So updates are expressed as per-type value lists,
 * merged into the current collection read moments before.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type {
  KeywordUpdate,
  OnBaseKeywordCollection,
  OnBaseKeywordGroup,
  OnBaseKeywordType,
} from './types';

export type KeywordResolveError = 'UNKNOWN_KEYWORD_TYPE' | 'AMBIGUOUS_KEYWORD_TYPE';
export type KeywordMergeError = 'AMBIGUOUS_KEYWORD_GROUP';

const CANDIDATE_LIMIT = 15;

/**
 * Resolve one keyword-type reference — an id or a name — to its id.
 *
 * An exact id match wins outright (ids are what the API hands back, so a
 * caller echoing one must never be second-guessed). Otherwise the localized
 * and system names are matched case-insensitively; zero or multiple matches
 * are errors that NAME the alternatives, so the caller's retry can be exact
 * instead of a guess.
 */
export function resolveKeywordTypeRef(
  catalog: readonly OnBaseKeywordType[],
  ref: string
): Result<string, KeywordResolveError> {
  const trimmed = ref.trim();
  const byId = catalog.find((t) => t.id === trimmed);
  if (byId) return ok(byId.id);

  const wanted = trimmed.toLowerCase();
  const matches = catalog.filter(
    (t) => t.name?.toLowerCase() === wanted || t.systemName?.toLowerCase() === wanted
  );
  if (matches.length === 1) return ok(matches[0].id);
  if (matches.length > 1) {
    return err('AMBIGUOUS_KEYWORD_TYPE' as const, {
      message: `"${ref}" matches ${matches.length} keyword types: ${describe(matches)}. Use the id.`,
    });
  }
  return err('UNKNOWN_KEYWORD_TYPE' as const, {
    message: `No keyword type is named "${ref}". Known types: ${describe(catalog)}${
      catalog.length > CANDIDATE_LIMIT ? ` and ${catalog.length - CANDIDATE_LIMIT} more` : ''
    }.`,
  });
}

function describe(types: readonly OnBaseKeywordType[]): string {
  return types
    .slice(0, CANDIDATE_LIMIT)
    .map((t) => `${t.name ?? t.systemName ?? '(unnamed)'} (id ${t.id})`)
    .join(', ');
}

/**
 * Merge per-type value updates into a document's current keyword
 * collection, producing the complete payload the PUT demands.
 *
 * Rules, in order per update:
 *   - the type appears in exactly one group → its values are replaced there
 *     (an empty list blanks the keyword, per the API's own convention);
 *   - the type appears in multiple groups (MultiInstance keyword groups) →
 *     refused: which instance to change is not inferable, and guessing
 *     would corrupt business data;
 *   - the type appears nowhere → appended as a new standalone entry.
 *
 * Everything not named by an update is carried through untouched, including
 * the keywordGuid the server uses to check restricted-keyword integrity.
 */
export function mergeKeywordCollections(
  current: OnBaseKeywordCollection,
  updates: readonly KeywordUpdate[]
): Result<OnBaseKeywordCollection, KeywordMergeError> {
  const items: OnBaseKeywordGroup[] = current.items.map((group) => ({
    ...group,
    keywords: group.keywords.map((keyword) => ({
      ...keyword,
      values: keyword.values?.map((value) => ({ ...value })),
    })),
  }));

  const appended: OnBaseKeywordGroup = { keywords: [] };

  for (const update of updates) {
    const hits = items.flatMap((group) =>
      group.keywords.filter((keyword) => keyword.typeId === update.typeId)
    );
    if (hits.length > 1) {
      return err('AMBIGUOUS_KEYWORD_GROUP' as const, {
        message: `Keyword type ${update.typeId} appears in ${hits.length} keyword group instances on this document; updating it needs a group-aware edit this tool does not support.`,
      });
    }
    const values = update.values.map((value) => ({ value }));
    if (hits.length === 1) {
      hits[0].values = values;
    } else {
      appended.keywords.push({ typeId: update.typeId, values });
    }
  }

  return ok({
    keywordGuid: current.keywordGuid,
    items: appended.keywords.length > 0 ? [...items, appended] : items,
  });
}

/**
 * Flatten a keyword collection to `type id → values` for display. Reading
 * is forgiving where writing is strict: formattedValue is preferred when
 * the server provides one.
 */
export function flattenKeywordValues(
  collection: Pick<OnBaseKeywordCollection, 'items'>
): { typeId: string; values: string[] }[] {
  const byType = new Map<string, string[]>();
  for (const group of collection.items) {
    for (const keyword of group.keywords) {
      if (!keyword.typeId) continue;
      const bucket = byType.get(keyword.typeId) ?? [];
      for (const value of keyword.values ?? []) {
        const shown = value.formattedValue ?? value.value;
        if (shown !== undefined) bucket.push(shown);
      }
      byType.set(keyword.typeId, bucket);
    }
  }
  return [...byType.entries()].map(([typeId, values]) => ({ typeId, values }));
}
