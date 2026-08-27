/**
 * @renkei/connector-onbase — the pure OnBase logic: OIDC discovery
 * parsing, keyword-type name resolution, the keyword merge that guards the
 * replace-everything PUT, query building, and the vocabulary cache.
 *
 * Deliberately dependency-free and I/O-free: HTTP against the customer's
 * OnBase API Server and Hyland IdP happens only in apps/worker-onbase, and
 * the web app reaches that worker through its service client. This package
 * is what both sides (and their tests) share.
 */

export type {
  OnBaseKeywordType,
  OnBaseDocumentType,
  OnBaseDocumentTypeGroup,
  OnBaseCustomQuery,
  OnBaseKeywordValue,
  OnBaseKeywordEntry,
  OnBaseKeywordGroup,
  OnBaseKeywordCollection,
  KeywordUpdate,
  OnBaseQueryKeyword,
  OnBaseQueryInformation,
  QueryOperator,
  QueryRelation,
  QueryTargetKind,
  OnBaseIdpEndpoints,
} from './types';
export {
  oidcDiscoveryUrl,
  parseDiscoveryDocument,
  type DiscoveryError,
} from './discovery';
export {
  resolveKeywordTypeRef,
  mergeKeywordCollections,
  flattenKeywordValues,
  type KeywordResolveError,
  type KeywordMergeError,
} from './keywords';
export { buildQueryInformation, type QueryBuildError, type QueryTarget } from './query';
export { CatalogCache, CATALOG_CACHE_TTL_MS } from './catalog-cache';
