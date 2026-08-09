import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_ATLASSIAN_SCOPES,
  ALL_ATLASSIAN_JSM_SCOPES,
  ATLASSIAN_SCOPE_OPTIONS,
  ATLASSIAN_JSM_SCOPE_OPTIONS,
  DEFAULT_ATLASSIAN_SCOPES,
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

  it('has unique option ids across both catalogs', () => {
    const ids = [...ATLASSIAN_SCOPE_OPTIONS, ...ATLASSIAN_JSM_SCOPE_OPTIONS].map(
      (option) => option.id
    );
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
  it('keeps the catalogs disjoint — a scope belongs to exactly one app', () => {
    const jira = new Set(ALL_ATLASSIAN_SCOPES);
    const overlap = ALL_ATLASSIAN_JSM_SCOPES.filter((scope) => jira.has(scope));
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
