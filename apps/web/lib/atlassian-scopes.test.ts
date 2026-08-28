import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_ATLASSIAN_SCOPES,
  ALL_ATLASSIAN_JSM_SCOPES,
  ALL_ATLASSIAN_CONFLUENCE_SCOPES,
  ATLASSIAN_SCOPE_OPTIONS,
  ATLASSIAN_JSM_SCOPE_OPTIONS,
  ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS,
  DEFAULT_ATLASSIAN_SCOPES,
  DEFAULT_ATLASSIAN_CONFLUENCE_SCOPES,
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

  it('has unique option ids across all three catalogs', () => {
    const ids = [
      ...ATLASSIAN_SCOPE_OPTIONS,
      ...ATLASSIAN_JSM_SCOPE_OPTIONS,
      ...ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS,
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
    // write:issue:jira is the third: the servicedeskapi cannot set an
    // assignee at all, nor a priority the request form does not carry, so
    // jsm_create_request finishes both with one platform edit right after
    // the create — without it, agents filed every request unassigned.
    // All are DELIBERATE — this list is the record that somebody weighed
    // each one, which is why the invariant is an allowlist rather than a
    // count.
    const shared = new Set([
      'read:user:jira',
      'read:project.component:jira',
      'write:issue:jira',
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
