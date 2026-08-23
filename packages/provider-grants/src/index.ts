/**
 * @renkei/provider-grants — the per-user OAuth grant lifecycle behind a
 * provider interface (RENKEI.md Decision #9: adding a provider means a new
 * adapter and new rows, never new bespoke plumbing).
 *
 * The generic parts: the encrypted subject-bound grant store, and
 * cross-process token refresh with distributed locking and revoked-grant
 * cleanup. The provider-specific part is the ProviderAdapter each connector
 * implements; AtlassianAdapter is the first.
 */

export type {
  ProviderGrant,
  NewProviderGrant,
  ProviderAdapter,
  RefreshedTokens,
  RefreshError,
  GrantLogger,
} from './types';
export { silentLogger } from './types';
export { getGrant, setGrant, deleteGrant } from './store';
export { refreshGrantTokens } from './refresh';
export { scopesFromAccessToken } from './token-claims';
export {
  ATLASSIAN,
  ATLASSIAN_JSM,
  ATLASSIAN_CONFLUENCE,
  AtlassianAdapter,
  readAtlassianMetadata,
} from './atlassian';
export { WEBEX_USER, WebexUserAdapter } from './webex';
export { ZOOM, ZoomAdapter } from './zoom';
export { MICROSOFT, MicrosoftAdapter } from './microsoft';
export {
  outlookIndexingOf,
  OUTLOOK_INDEXING_CATEGORIES,
  type OutlookIndexingPrefs,
} from './outlook-indexing';
