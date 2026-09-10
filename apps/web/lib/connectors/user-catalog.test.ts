/**
 * The page's three sets, without a database: what may be added, what is
 * connected, and what is shown — and the one rule that matters most, that a
 * connection somebody already has never loses its card to a preference.
 */

import { availableEntries, connectedKeys, shownKeys } from './user-catalog';

const labels = (entries: { label: string }[]) => entries.map((entry) => entry.label);

describe('availableEntries', () => {
  it('offers only what the org has provisioned', () => {
    const available = availableEntries({
      enabledConfigKeys: new Set(['atlassian', 'microsoft']),
      anyShares: false,
      disabledConnectors: [],
    });
    expect(labels(available)).toEqual(['Jira', 'Outlook', 'SharePoint', 'OneDrive']);
  });

  it('never offers a Renkei surface as something to add', () => {
    const available = availableEntries({
      enabledConfigKeys: new Set(['embeddings', 'web-search', 'cards', 'agents']),
      anyShares: false,
      disabledConnectors: [],
    });
    expect(available).toEqual([]);
  });

  it('drops a connector the org switched off', () => {
    const available = availableEntries({
      enabledConfigKeys: new Set(['microsoft']),
      anyShares: false,
      disabledConnectors: ['sharepoint'],
    });
    expect(labels(available)).toEqual(['Outlook', 'OneDrive']);
  });

  it('offers file shares when any share is registered, with no config row', () => {
    const available = availableEntries({
      enabledConfigKeys: new Set(),
      anyShares: true,
      disabledConnectors: [],
    });
    expect(labels(available)).toEqual(['File shares']);
  });

  it('lets the audience gate remove an entry', () => {
    const available = availableEntries({
      enabledConfigKeys: new Set(['zoom', 'atlassian-bitbucket']),
      anyShares: false,
      disabledConnectors: [],
      audienceAllows: (key) => key !== 'atlassian-bitbucket',
    });
    expect(labels(available)).toEqual(['Zoom']);
  });
});

describe('connectedKeys', () => {
  it('maps a grant provider to every product it backs', () => {
    // One Microsoft consent is Outlook, SharePoint and OneDrive.
    expect([...connectedKeys(new Set(['microsoft']), false)].sort()).toEqual([
      'microsoft',
      'onedrive',
      'sharepoint',
    ]);
  });

  it('keeps Jira and JSM on their own grants', () => {
    expect([...connectedKeys(new Set(['atlassian-jsm']), false)]).toEqual(['jira']);
  });

  it('counts a share connection as file shares', () => {
    expect([...connectedKeys(new Set(), true)]).toEqual(['fileshares']);
  });
});

describe('shownKeys', () => {
  const offered = availableEntries({
    enabledConfigKeys: new Set(['atlassian', 'zoom', 'microsoft']),
    anyShares: false,
    disabledConnectors: [],
  });

  it('shows what was added plus what is connected', () => {
    expect([...shownKeys(['zoom'], new Set(['jira']), offered)].sort()).toEqual(['jira', 'zoom']);
  });

  it('keeps a card for a connection made before the person ever added it', () => {
    expect([...shownKeys([], new Set(['microsoft']), offered)]).toEqual(['microsoft']);
  });

  it('hides a card the org no longer offers, added or connected', () => {
    // The grant stays; the projection already unregistered the tools.
    expect([...shownKeys(['onbase'], new Set(['atlassian-bitbucket']), offered)]).toEqual([]);
  });
});
