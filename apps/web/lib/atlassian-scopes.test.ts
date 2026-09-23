import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_ATLASSIAN_SCOPES,
  ALL_ATLASSIAN_JSM_SCOPES,
  ALL_ATLASSIAN_CONFLUENCE_SCOPES,
  ALL_ATLASSIAN_ADMIN_SCOPES,
  ATLASSIAN_SCOPE_OPTIONS,
  ATLASSIAN_JSM_SCOPE_OPTIONS,
  ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS,
  ATLASSIAN_ADMIN_SCOPE_OPTIONS,
  DEFAULT_ATLASSIAN_SCOPES,
  DEFAULT_ATLASSIAN_CONFLUENCE_SCOPES,
  DEFAULT_ATLASSIAN_ADMIN_SCOPES,
  usableAtlassianAdminCeiling,
} from './atlassian-scopes';

/**
 * The catalog and docs/atlassian-granular-scopes.md are two renderings of one
 * derivation (spec endpoints → granular scopes). A scope string typo'd in the
 * catalog silently breaks its whole bundle at the consent screen, so the two
 * must stay identical — this is the tripwire.
 */
describe('atlassian scope catalog', () => {
  const doc = readFileSync(join(__dirname, '../../../docs/atlassian-granular-scopes.md'), 'utf8');
  const documented = new Set(
    [...doc.matchAll(/^((?:read|write|delete):[a-z0-9.:_-]+)$/gm)].map((m) => m[1])
  );

  it('carries exactly the documented granular scopes across both apps', () => {
    const catalog = new Set([...ALL_ATLASSIAN_SCOPES, ...ALL_ATLASSIAN_JSM_SCOPES]);
    const missingFromCatalog = [...documented].filter((scope) => !catalog.has(scope));
    const undocumented = [...catalog].filter((scope) => !documented.has(scope));
    expect(missingFromCatalog).toEqual([]);
    expect(undocumented).toEqual([]);
  });

  it('has no classic scopes anywhere', () => {
    const classic = [...ALL_ATLASSIAN_SCOPES, ...ALL_ATLASSIAN_JSM_SCOPES].filter((scope) =>
      /^(read|write):jira-(work|user)$|servicedesk-request|manage:/.test(scope)
    );
    expect(classic).toEqual([]);
  });

  it('has unique option ids across the 3LO catalogs', () => {
    const ids = [
      ...ATLASSIAN_SCOPE_OPTIONS,
      ...ATLASSIAN_JSM_SCOPE_OPTIONS,
      ...ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS,
      ...ATLASSIAN_ADMIN_SCOPE_OPTIONS,
    ].map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defaults include offline_access and only default bundles', () => {
    const defaults = DEFAULT_ATLASSIAN_SCOPES.split(' ');
    expect(defaults).toContain('offline_access');
    const defaultBundleScopes = new Set(
      ATLASSIAN_SCOPE_OPTIONS.filter((option) => option.defaultChecked).flatMap(
        (option) => option.scopes
      )
    );
    for (const scope of defaults) {
      if (scope === 'offline_access') continue;
      expect(defaultBundleScopes.has(scope)).toBe(true);
    }
  });
});

describe('two-app split invariants', () => {
  it('keeps the catalogs disjoint, except the documented shared scopes', () => {
    // read:user:jira rides both apps: JSM payloads embed user objects and
    // all-of enforcement demands it on most servicedeskapi endpoints.
    //
    // read:project.component:jira is the second, and for the same shape of
    // reason: the servicedeskapi has no components endpoint at all, so
    // jsm_list_components has to ask the platform for the desk's project.
    //
    // write:issue:jira and read:issue:jira are the third and fourth: the
    // servicedeskapi cannot set an assignee at all, nor a priority, story
    // points, an estimate, or a custom field the request form does not
    // carry, so jsm_create_request finishes them with one platform edit
    // right after the create (write), resolving field names against the
    // platform field schema (read) — without them, agents filed every
    // request unassigned and unestimated.
    // All are DELIBERATE — this list is the record that somebody weighed
    // each one, which is why the invariant is an allowlist rather than a
    // count.
    const shared = new Set([
      'read:user:jira',
      'read:project.component:jira',
      'write:issue:jira',
      'read:issue:jira',
    ]);
    const jira = new Set(ALL_ATLASSIAN_SCOPES);
    const overlap = ALL_ATLASSIAN_JSM_SCOPES.filter(
      (scope) => jira.has(scope) && !shared.has(scope)
    );
    expect(overlap).toEqual([]);
  });

  it('keeps each app comfortably under the consent-URL cliff', () => {
    // The split exists because the combined union could not fit; each half
    // must never grow back over it. 2900 mirrors the connect-card warning.
    for (const scopes of [ALL_ATLASSIAN_SCOPES, ALL_ATLASSIAN_JSM_SCOPES]) {
      const est = 250 + encodeURIComponent([...scopes, 'offline_access'].join(' ')).length;
      expect(est).toBeLessThan(2900);
    }
  });
});

/**
 * The third app ("Renkei Confluence") — a genuinely separate product
 * surface, not a shared-site sibling like JSM, so its own doc
 * (docs/atlassian-confluence-granular-scopes.md) is the source of truth
 * and gets the same tripwire treatment.
 */
describe('confluence scope catalog', () => {
  const doc = readFileSync(
    join(__dirname, '../../../docs/atlassian-confluence-granular-scopes.md'),
    'utf8'
  );
  const documented = new Set(
    [...doc.matchAll(/^((?:read|write|delete):[a-z0-9.:_-]+)$/gm)].map((m) => m[1])
  );

  it('carries exactly the documented granular scopes', () => {
    const catalog = new Set(ALL_ATLASSIAN_CONFLUENCE_SCOPES);
    const missingFromCatalog = [...documented].filter((scope) => !catalog.has(scope));
    const undocumented = [...catalog].filter((scope) => !documented.has(scope));
    expect(missingFromCatalog).toEqual([]);
    expect(undocumented).toEqual([]);
  });

  it('has no classic scopes', () => {
    const classic = ALL_ATLASSIAN_CONFLUENCE_SCOPES.filter((scope) =>
      /^read:confluence-|^write:confluence-|^manage:/.test(scope)
    );
    expect(classic).toEqual([]);
  });

  it('every scope carries the confluence product suffix', () => {
    const wrongProduct = ALL_ATLASSIAN_CONFLUENCE_SCOPES.filter(
      (scope) => !scope.endsWith(':confluence')
    );
    expect(wrongProduct).toEqual([]);
  });

  it('is disjoint from the Jira and JSM catalogs', () => {
    const others = new Set([...ALL_ATLASSIAN_SCOPES, ...ALL_ATLASSIAN_JSM_SCOPES]);
    const overlap = ALL_ATLASSIAN_CONFLUENCE_SCOPES.filter((scope) => others.has(scope));
    expect(overlap).toEqual([]);
  });

  it('defaults include offline_access and only default bundles', () => {
    const defaults = DEFAULT_ATLASSIAN_CONFLUENCE_SCOPES.split(' ');
    expect(defaults).toContain('offline_access');
    const defaultBundleScopes = new Set(
      ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS.filter((option) => option.defaultChecked).flatMap(
        (option) => option.scopes
      )
    );
    for (const scope of defaults) {
      if (scope === 'offline_access') continue;
      expect(defaultBundleScopes.has(scope)).toBe(true);
    }
  });

  it('stays comfortably under the consent-URL cliff', () => {
    const est =
      250 +
      encodeURIComponent([...ALL_ATLASSIAN_CONFLUENCE_SCOPES, 'offline_access'].join(' ')).length;
    expect(est).toBeLessThan(2900);
  });
});

/**
 * The fifth app ("Renkei Jira Admin") — the one CLASSIC catalog, so the
 * classic/granular tripwire runs the other way here: one app cannot mix the
 * two, and the Plans and Forms APIs take classic scopes only. Its own doc
 * (docs/atlassian-admin-scopes.md) is the source of truth.
 */
describe('jira admin scope catalog', () => {
  const doc = readFileSync(join(__dirname, '../../../docs/atlassian-admin-scopes.md'), 'utf8');
  const documented = new Set(
    [...doc.matchAll(/^((?:read|write|manage):jira-[a-z-]+)$/gm)].map((m) => m[1])
  );

  it('carries exactly the documented classic scopes', () => {
    const catalog = new Set(ALL_ATLASSIAN_ADMIN_SCOPES);
    const missingFromCatalog = [...documented].filter((scope) => !catalog.has(scope));
    const undocumented = [...catalog].filter((scope) => !documented.has(scope));
    expect(missingFromCatalog).toEqual([]);
    expect(undocumented).toEqual([]);
  });

  it('is classic only — a granular scope cannot share its app', () => {
    const notClassic = ALL_ATLASSIAN_ADMIN_SCOPES.filter(
      (scope) => !/^(read|write|manage):jira-[a-z-]+$/.test(scope)
    );
    expect(notClassic).toEqual([]);
  });

  it('shares no scope with any granular catalog', () => {
    const granular = new Set([
      ...ALL_ATLASSIAN_SCOPES,
      ...ALL_ATLASSIAN_JSM_SCOPES,
      ...ALL_ATLASSIAN_CONFLUENCE_SCOPES,
    ]);
    expect(ALL_ATLASSIAN_ADMIN_SCOPES.filter((scope) => granular.has(scope))).toEqual([]);
  });

  it('defaults include offline_access and only default bundles', () => {
    const defaults = DEFAULT_ATLASSIAN_ADMIN_SCOPES.split(' ');
    expect(defaults).toContain('offline_access');
    const defaultBundleScopes = new Set(
      ATLASSIAN_ADMIN_SCOPE_OPTIONS.filter((option) => option.defaultChecked).flatMap(
        (option) => option.scopes
      )
    );
    for (const scope of defaults) {
      if (scope === 'offline_access') continue;
      expect(defaultBundleScopes.has(scope)).toBe(true);
    }
  });

  it('keeps a stored ceiling to known admin scopes, falling back to the defaults', () => {
    expect(usableAtlassianAdminCeiling('read:jira-work read:issue:jira')).toEqual([
      'read:jira-work',
    ]);
    // A ceiling holding nothing this catalog knows (granular scopes pasted in
    // from the Jira app, say) degrades to the defaults rather than to nothing.
    expect(usableAtlassianAdminCeiling('read:issue:jira')).toEqual(
      DEFAULT_ATLASSIAN_ADMIN_SCOPES.split(' ')
    );
  });

  it('stays comfortably under the consent-URL cliff', () => {
    const est =
      250 + encodeURIComponent([...ALL_ATLASSIAN_ADMIN_SCOPES, 'offline_access'].join(' ')).length;
    expect(est).toBeLessThan(2900);
  });
});
