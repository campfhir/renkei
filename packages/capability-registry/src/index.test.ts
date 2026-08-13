/**
 * The projection's contract: three gates, applied org → provisioning → user,
 * each only ever narrowing. These tests are the registry's spec.
 */

import { createProjection, projectCapabilities, OPEN_ORG_POLICY } from './index';
import type { CapabilityDescriptor, UserCapabilitySelection } from './index';

const DECLARED: CapabilityDescriptor[] = [
  { id: 'jira_search_issues', connector: 'jira', kind: 'read' },
  { id: 'jira_create_issue', connector: 'jira', kind: 'act' },
  { id: 'get_thread', connector: 'webex', kind: 'read' },
  { id: 'post_reply', connector: 'webex', kind: 'act' },
];

const EVERYTHING: UserCapabilitySelection = {
  provisionedConnectors: ['jira', 'webex'],
  hiddenCapabilities: [],
};

function ids(capabilities: CapabilityDescriptor[]): string[] {
  return capabilities.map((c) => c.id);
}

describe('projectCapabilities', () => {
  it('passes everything for an open org and a fully provisioned user', () => {
    expect(ids(projectCapabilities(DECLARED, OPEN_ORG_POLICY, EVERYTHING))).toEqual(ids(DECLARED));
  });

  it('org read-only mode removes every acting capability for every user', () => {
    const projected = projectCapabilities(
      DECLARED,
      { ...OPEN_ORG_POLICY, readOnly: true },
      EVERYTHING
    );
    expect(ids(projected)).toEqual(['jira_search_issues', 'get_thread']);
  });

  it('a disabled connector exposes nothing, regardless of user choices', () => {
    const projected = projectCapabilities(
      DECLARED,
      { ...OPEN_ORG_POLICY, disabledConnectors: ['webex'] },
      EVERYTHING
    );
    expect(ids(projected)).toEqual(['jira_search_issues', 'jira_create_issue']);
  });

  it('an org-disabled capability stays hidden even when provisioned and exposed', () => {
    const projected = projectCapabilities(
      DECLARED,
      { ...OPEN_ORG_POLICY, disabledCapabilities: ['jira_create_issue'] },
      EVERYTHING
    );
    expect(ids(projected)).not.toContain('jira_create_issue');
  });

  it('an unprovisioned connector exposes nothing', () => {
    const projected = projectCapabilities(DECLARED, OPEN_ORG_POLICY, {
      provisionedConnectors: ['jira'],
      hiddenCapabilities: [],
    });
    expect(ids(projected)).toEqual(['jira_search_issues', 'jira_create_issue']);
  });

  it('user hide choices narrow their own projection', () => {
    const projected = projectCapabilities(DECLARED, OPEN_ORG_POLICY, {
      ...EVERYTHING,
      hiddenCapabilities: ['post_reply'],
    });
    expect(ids(projected)).not.toContain('post_reply');
  });

  it('user choices cannot re-expose what the org disabled', () => {
    const projection = createProjection(
      { ...OPEN_ORG_POLICY, disabledCapabilities: ['jira_create_issue'] },
      { provisionedConnectors: ['jira'], hiddenCapabilities: [] }
    );
    expect(projection.allows({ id: 'jira_create_issue', connector: 'jira', kind: 'act' })).toBe(
      false
    );
  });
});
