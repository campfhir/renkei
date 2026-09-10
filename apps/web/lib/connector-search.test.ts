import { CONNECTOR_CATALOG, userConnectableConnectors } from './connector-catalog';
import { searchConnectors, scoreConnector } from './connector-search';

describe('searchConnectors', () => {
  it('returns everything, in catalog order, for an empty query', () => {
    expect(searchConnectors(CONNECTOR_CATALOG, '   ')).toEqual(CONNECTOR_CATALOG);
  });

  it('finds a product by a synonym a person would actually type', () => {
    // Nobody searching for their inbox types "Outlook" first.
    const labels = searchConnectors(userConnectableConnectors(), 'email').map((e) => e.label);
    expect(labels[0]).toBe('Outlook');
  });

  it('ranks a label hit above a keyword hit', () => {
    const labels = searchConnectors(CONNECTOR_CATALOG, 'zoom').map((e) => e.label);
    expect(labels[0]).toBe('Zoom');
  });

  it('matches every word, so a two-word query narrows', () => {
    const labels = searchConnectors(CONNECTOR_CATALOG, 'service desk').map((e) => e.label);
    expect(labels[0]).toBe('Jira Service Management');
  });

  it('drops entries that match nothing', () => {
    expect(searchConnectors(CONNECTOR_CATALOG, 'xyzzy')).toEqual([]);
  });

  it('is case-insensitive', () => {
    const entry = CONNECTOR_CATALOG.find((e) => e.label === 'Confluence')!;
    expect(scoreConnector(entry, 'WIKI')).toBeGreaterThan(0);
  });
});
