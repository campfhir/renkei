/**
 * The person's Connectors page: which cards it draws and in what order,
 * which of them sits under "Needs setup", what each card hosts, and the
 * ceilings, remove links and catalog it is handed. Moved from
 * e2e/connectors.spec.ts, which added Zoom and WebEx, watched both sit under
 * "Needs setup", connected Zoom and watched it move under "Connected", then
 * disconnected it and watched it move back.
 */

import {
  anyConnectorCard,
  atlassianProducts,
  catalogItems,
  ceilingFrom,
  connectorCards,
  microsoftShownKeys,
  pageSections,
  removableProducts,
  storedScopes,
  webexAllSpaces,
  zoomMissingScopes,
  type CardsInput,
} from './connectors-page.model';

function input(overrides: Partial<CardsInput> = {}): CardsInput {
  return {
    shown: new Set(),
    grants: new Set(),
    enabledConfigs: new Set(),
    salesforce: [],
    fileshares: [],
    mirth: [],
    admanager: [],
    mcpServers: [],
    browserSecrets: false,
    ...overrides,
  };
}

const keys = (cards: { key: string }[]) => cards.map((card) => card.key);

function sections(overrides: Partial<CardsInput>) {
  const { needsSetup, settled, settledHeading } = pageSections(connectorCards(input(overrides)));
  return { needsSetup: keys(needsSetup), settled: keys(settled), settledHeading };
}

describe('the connectors page sections', () => {
  it('Zoom and WebEx added but not connected both sit under "Needs setup"', () => {
    expect(sections({ shown: new Set(['zoom', 'webex']) })).toEqual({
      needsSetup: ['webex', 'zoom'],
      settled: [],
      settledHeading: null,
    });
  });

  it('connecting Zoom moves it under "Connected" while WebEx stays in "Needs setup"', () => {
    expect(sections({ shown: new Set(['zoom', 'webex']), grants: new Set(['zoom']) })).toEqual({
      needsSetup: ['webex'],
      settled: ['zoom'],
      settledHeading: 'Connected',
    });
  });

  it('with nothing to set up the connected cards carry no heading', () => {
    expect(
      sections({ shown: new Set(['zoom', 'webex']), grants: new Set(['zoom', 'webex']) })
    ).toEqual({ needsSetup: [], settled: ['webex', 'zoom'], settledHeading: null });
  });

  it('draws nothing when nothing is added or connected', () => {
    expect(connectorCards(input())).toEqual([]);
  });

  it('keeps every card in the page order inside each section', () => {
    const shown = new Set([
      'github',
      'zoom',
      'entra-developer',
      'teams',
      'webex',
      'confluence',
      'atlassian-confluence',
      'onbase',
      'fileshares',
      'mirth',
      'admanager',
    ]);
    const all = connectorCards(
      input({
        shown,
        mcpServers: [{ authMode: 'none', connected: false }],
        browserSecrets: true,
      })
    );
    expect(keys(all)).toEqual([
      'atlassian',
      'webex',
      'microsoft',
      'entra-developer',
      'zoom',
      'github',
      'hyland',
      'fileshares',
      'mirth',
      'admanager',
      'mcp-servers',
      'browser-secrets',
    ]);
  });

  it('Microsoft is one consent: any panel shown and no grant needs setup, the grant settles it', () => {
    expect(sections({ shown: new Set(['onedrive']) }).needsSetup).toEqual(['microsoft']);
    expect(
      sections({ shown: new Set(['onedrive', 'teams']), grants: new Set(['microsoft']) }).settled
    ).toEqual(['microsoft']);
  });

  it('the browser secrets card is never something to set up', () => {
    expect(sections({ browserSecrets: true })).toEqual({
      needsSetup: [],
      settled: ['browser-secrets'],
      settledHeading: null,
    });
  });
});

describe('the Atlassian card', () => {
  it('hosts Jira and JSM only where the org registered each app', () => {
    expect(atlassianProducts(new Set(['jira']), new Set(['atlassian']))).toEqual({
      jira: true,
      jsm: false,
      jiraAdmin: false,
      confluence: false,
      bitbucket: false,
    });
    expect(atlassianProducts(new Set(['jira']), new Set(['atlassian', 'atlassian-jsm'])).jsm).toBe(
      true
    );
  });

  it('needs setup while any product it hosts is unconnected', () => {
    const shown = new Set(['jira', 'atlassian-confluence']);
    const enabledConfigs = new Set(['atlassian', 'atlassian-jsm']);
    expect(
      sections({ shown, enabledConfigs, grants: new Set(['atlassian', 'atlassian-confluence']) })
        .needsSetup
    ).toEqual(['atlassian']);
    expect(
      sections({
        shown,
        enabledConfigs,
        grants: new Set(['atlassian', 'atlassian-jsm', 'atlassian-confluence']),
      }).settled
    ).toEqual(['atlassian']);
  });

  it('a Jira product the org has not registered is nothing to set up', () => {
    expect(sections({ shown: new Set(['jira']) }).settled).toEqual(['atlassian']);
  });
});

describe('the Hyland card', () => {
  it('needs setup while OnBase or OnBase admin is shown and unconnected', () => {
    expect(sections({ shown: new Set(['onbase-admin']) }).needsSetup).toEqual(['hyland']);
    expect(
      sections({ shown: new Set(['onbase', 'onbase-admin']), grants: new Set(['onbase']) })
        .needsSetup
    ).toEqual(['hyland']);
    expect(sections({ shown: new Set(['onbase']), grants: new Set(['onbase']) }).settled).toEqual([
      'hyland',
    ]);
  });
});

describe('the registered-instance cards (file shares, Mirth, AD Manager)', () => {
  it.each(['fileshares', 'mirth', 'admanager'] as const)(
    '%s needs setup while any registered one is unconnected',
    (key) => {
      expect(
        sections({ shown: new Set([key]), [key]: [{ connected: true }, { connected: false }] })
          .needsSetup
      ).toEqual([key]);
      expect(sections({ shown: new Set([key]), [key]: [{ connected: true }] }).settled).toEqual([
        key,
      ]);
    }
  );

  it('with nothing registered there is nothing to set up', () => {
    expect(sections({ shown: new Set(['fileshares']) }).settled).toEqual(['fileshares']);
  });
});

describe('the MCP servers card', () => {
  it('shows only when a server is offered', () => {
    expect(connectorCards(input({ mcpServers: [] }))).toEqual([]);
  });

  it('needs setup only for an unconnected server that signs in', () => {
    expect(sections({ mcpServers: [{ authMode: 'none', connected: false }] }).settled).toEqual([
      'mcp-servers',
    ]);
    expect(
      sections({
        mcpServers: [
          { authMode: 'none', connected: false },
          { authMode: 'oauth', connected: false },
        ],
      }).needsSetup
    ).toEqual(['mcp-servers']);
    expect(sections({ mcpServers: [{ authMode: 'oauth', connected: true }] }).settled).toEqual([
      'mcp-servers',
    ]);
  });
});

describe('the Salesforce cards', () => {
  it('draws a card per enabled org, each set up on its own, the last carrying the remove link', () => {
    const cards = connectorCards(
      input({
        salesforce: [
          { kindKey: 'salesforce', orgKeys: ['prod', 'sandbox'], connectedOrgs: ['sandbox'] },
        ],
      })
    );
    expect(cards).toEqual([
      {
        kind: 'salesforce',
        key: 'salesforce:prod',
        kindKey: 'salesforce',
        orgKey: 'prod',
        last: false,
        needsAttention: true,
      },
      {
        kind: 'salesforce',
        key: 'salesforce:sandbox',
        kindKey: 'salesforce',
        orgKey: 'sandbox',
        last: true,
        needsAttention: false,
      },
    ]);
  });

  it('a connection to an org since removed gets its own card, always under "Needs setup"', () => {
    expect(
      sections({
        salesforce: [
          { kindKey: 'salesforce', orgKeys: ['prod'], connectedOrgs: ['prod', null] },
          { kindKey: 'salesforce-admin', orgKeys: [], connectedOrgs: [null, null] },
        ],
      })
    ).toEqual({
      needsSetup: ['salesforce:removed', 'salesforce-admin:removed'],
      settled: ['salesforce:prod'],
      settledHeading: 'Connected',
    });
  });

  it('come after GitHub and before Hyland', () => {
    expect(
      keys(
        connectorCards(
          input({
            shown: new Set(['github', 'onbase']),
            salesforce: [{ kindKey: 'salesforce', orgKeys: ['prod'], connectedOrgs: [] }],
          })
        )
      )
    ).toEqual(['github', 'salesforce:prod', 'hyland']);
  });
});

describe('whether the page has any connector card', () => {
  it('is false with nothing added, so the page offers "Nothing added yet"', () => {
    expect(anyConnectorCard(new Set(), 0)).toBe(false);
  });

  it('counts a Salesforce kind added even before an org is enabled', () => {
    expect(anyConnectorCard(new Set(['salesforce-admin']), 0)).toBe(true);
  });

  it('counts an offered MCP server, and any single product', () => {
    expect(anyConnectorCard(new Set(), 1)).toBe(true);
    expect(anyConnectorCard(new Set(['zoom']), 0)).toBe(true);
    expect(anyConnectorCard(new Set(['sharepoint']), 0)).toBe(true);
  });
});

describe('what the cards are handed', () => {
  it('the ceiling is the org saved scopes, or the catalog defaults', () => {
    expect(ceilingFrom({ scopes: 'a b  c' }, 'x y')).toEqual(['a', 'b', 'c']);
    expect(ceilingFrom({ scopes: '' }, 'x y')).toEqual(['x', 'y']);
    expect(ceilingFrom(null, 'x y')).toEqual(['x', 'y']);
    expect(ceilingFrom({ scopes: ['a'] }, 'x')).toEqual(['x']);
    expect(storedScopes(undefined)).toBeNull();
    expect(storedScopes({ scopes: 'a' })).toBe('a');
  });

  it('the Microsoft panels on the page, in the card order', () => {
    expect(microsoftShownKeys(new Set(['teams', 'microsoft', 'zoom']))).toEqual([
      'microsoft',
      'teams',
    ]);
  });

  it('offers to take back off only products on the page with nothing connected', () => {
    const catalog = { shown: new Set(['jira', 'jira-admin']), connected: new Set(['jira-admin']) };
    expect(
      removableProducts(catalog, ['jira', 'jira-admin', 'atlassian-confluence'], (key) =>
        key.toUpperCase()
      )
    ).toEqual([{ capabilityKey: 'jira', label: 'JIRA' }]);
  });

  it('the Add connector catalog marks each offered entry added and connected', () => {
    expect(
      catalogItems({
        available: [{ capabilityKey: 'zoom' }, { capabilityKey: 'webex' }],
        shown: new Set(['zoom']),
        connected: new Set(['webex']),
        added: ['zoom'],
      })
    ).toEqual([
      { entry: { capabilityKey: 'zoom' }, added: true, connected: false },
      { entry: { capabilityKey: 'webex' }, added: false, connected: true },
    ]);
  });

  it("Zoom's warning lists the scopes asked for that the token does not carry", () => {
    expect(
      zoomMissingScopes({
        requestedScopes: ['meeting:read', 'recording:read'],
        grantedScopes: ['meeting:read'],
      })
    ).toEqual(['recording:read']);
  });

  it('Zoom claims no drift without a grant or without recorded granted scopes', () => {
    expect(zoomMissingScopes(undefined)).toEqual([]);
    expect(zoomMissingScopes({ requestedScopes: ['a'], grantedScopes: null })).toEqual([]);
    expect(zoomMissingScopes({ requestedScopes: null, grantedScopes: ['a'] })).toEqual([]);
  });

  it('WebEx reads every space only when the grant says so', () => {
    expect(webexAllSpaces({ metadata: { allSpaces: true } })).toBe(true);
    expect(webexAllSpaces({ metadata: { allSpaces: 'yes' } })).toBe(false);
    expect(webexAllSpaces({ metadata: [] })).toBe(false);
    expect(webexAllSpaces(undefined)).toBe(false);
  });
});
