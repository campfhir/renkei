/**
 * `sources` maps caller-facing names onto provider+kind filters that are
 * ANDed together in SQL. The trap this guards: some sources pin a
 * `metadata.kind` and others don't, so naively unioning kinds would AND a
 * kind filter against providers whose chunks carry no kind at all and
 * silently return nothing for them.
 */

jest.mock('@renkei/connector-atlassian', () => ({
  createJiraAccessVerifier: () => ({ provider: 'jira' }),
  createConfluenceAccessVerifier: () => ({ provider: 'confluence' }),
  JIRA_KNOWLEDGE_PROVIDER: 'jira',
  CONFLUENCE_KNOWLEDGE_PROVIDER: 'confluence',
}));
jest.mock('@renkei/provider-grants', () => ({
  getGrant: async () => ({ ok: false }),
  readAtlassianMetadata: () => ({ cloudId: '', siteUrl: '' }),
  ATLASSIAN: 'atlassian',
  ATLASSIAN_CONFLUENCE: 'atlassian-confluence',
}));
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: false }) }));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/connector-config', () => ({
  readConnectorConfigCached: async () => ({ ok: false }),
}));
jest.mock('@renkei/connector-webex', () => ({
  WEBEX_CONNECTOR: 'webex',
  WebexClient: class {},
  createWebexAccessVerifier: () => ({ provider: 'webex' }),
}));
jest.mock('@renkei/connector-microsoft', () => ({
  MICROSOFT_CONNECTOR: 'microsoft',
  createMicrosoftAccessVerifier: () => ({ provider: 'microsoft' }),
}));
jest.mock('@renkei/connector-zoom', () => ({
  ZOOM_CONNECTOR: 'zoom',
  createZoomAccessVerifier: () => ({ provider: 'zoom' }),
}));
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: async () => null,
  searchKnowledge: async () => ({ ok: true, val: { hits: [], elided: 0 } }),
}));
jest.mock('@/lib/logger', () => ({
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));

import { sourceFiltersFor, KNOWLEDGE_SOURCE_NAMES } from './index';

describe('sourceFiltersFor', () => {
  it('returns no filters when nothing is selected', () => {
    expect(sourceFiltersFor([])).toEqual({});
  });

  it('maps a product name onto the stored provider, not the product name', () => {
    // The column says 'microsoft'; nobody calling this tool would guess that.
    expect(sourceFiltersFor(['outlook_mail'])).toEqual({
      providers: ['microsoft'],
      kinds: ['msg'],
    });
  });

  it('dedupes providers across sibling sources', () => {
    const filters = sourceFiltersFor(['outlook_mail', 'outlook_calendar']);
    expect(filters.providers).toEqual(['microsoft']);
    expect(filters.kinds?.sort()).toEqual(['evt', 'msg']);
  });

  it('drops the kind filter when any selected source has no kind', () => {
    // outlook_mail pins kind 'msg'; zoom chunks have kind 'transcript'/'summary'.
    // ANDing kind=['msg'] would return zero Zoom results — the whole reason
    // this branch exists.
    const filters = sourceFiltersFor(['outlook_mail', 'zoom']);
    expect(filters.providers?.sort()).toEqual(['microsoft', 'zoom']);
    expect(filters.kinds).toBeUndefined();
  });

  it('ignores unknown source names rather than filtering to nothing', () => {
    expect(sourceFiltersFor(['not_a_source'])).toEqual({});
    expect(sourceFiltersFor(['not_a_source', 'jira'])).toEqual({ providers: ['jira'] });
  });

  it('exposes every source name the tool schema offers', () => {
    expect(KNOWLEDGE_SOURCE_NAMES).toEqual(
      expect.arrayContaining([
        'outlook_mail',
        'outlook_calendar',
        'outlook_tasks',
        'zoom',
        'webex',
        'confluence',
        'jira',
      ])
    );
  });
});
