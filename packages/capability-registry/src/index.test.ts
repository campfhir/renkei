/**
 * The projection's contract: five gates, applied org → roles → audience →
 * provisioning → user, each only ever narrowing. These tests are the registry's spec.
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

  it('a capability with a requiredRole is hidden from a caller without it', () => {
    const projection = createProjection(OPEN_ORG_POLICY, {
      provisionedConnectors: ['jira'],
      hiddenCapabilities: [],
      roles: ['renkei-user'],
    });
    expect(
      projection.allows({
        id: 'jira_admin_tool',
        connector: 'jira',
        kind: 'act',
        requiredRole: 'renkei-operator',
      })
    ).toBe(false);
  });

  it('a capability with a requiredRole is visible to a caller holding it', () => {
    const projection = createProjection(OPEN_ORG_POLICY, {
      provisionedConnectors: ['jira'],
      hiddenCapabilities: [],
      roles: ['renkei-user', 'renkei-operator'],
    });
    expect(
      projection.allows({
        id: 'jira_admin_tool',
        connector: 'jira',
        kind: 'act',
        requiredRole: 'renkei-operator',
      })
    ).toBe(true);
  });

  it('omitting roles altogether hides any role-gated capability', () => {
    const projection = createProjection(OPEN_ORG_POLICY, {
      provisionedConnectors: ['jira'],
      hiddenCapabilities: [],
    });
    expect(
      projection.allows({
        id: 'jira_admin_tool',
        connector: 'jira',
        kind: 'act',
        requiredRole: 'renkei-operator',
      })
    ).toBe(false);
  });

  it('a restricted connector exposes nothing to a caller outside its audience', () => {
    // The gate that turns "hide the card" into a real restriction: outside
    // the audience, reads and acts alike are never registered.
    const projection = createProjection(
      { ...OPEN_ORG_POLICY, restrictedConnectors: ['webex'] },
      { ...EVERYTHING, allowedConnectors: [] }
    );
    expect(projection.allows({ id: 'get_thread', connector: 'webex', kind: 'read' })).toBe(false);
    expect(projection.allows({ id: 'post_reply', connector: 'webex', kind: 'act' })).toBe(false);
    expect(projection.allows({ id: 'jira_search_issues', connector: 'jira', kind: 'read' })).toBe(
      true
    );
  });

  it('a restricted connector is unchanged for a caller inside its audience', () => {
    const projection = createProjection(
      { ...OPEN_ORG_POLICY, restrictedConnectors: ['webex'] },
      { ...EVERYTHING, allowedConnectors: ['webex'] }
    );
    expect(projection.allows({ id: 'get_thread', connector: 'webex', kind: 'read' })).toBe(true);
  });

  it('omitting allowedConnectors closes every restricted connector', () => {
    // The fail-closed default: a caller whose audience could not be
    // resolved is outside every audience.
    const projection = createProjection(
      { ...OPEN_ORG_POLICY, restrictedConnectors: ['webex'] },
      EVERYTHING
    );
    expect(projection.allows({ id: 'get_thread', connector: 'webex', kind: 'read' })).toBe(false);
  });

  it('being in an audience cannot widen a disabled or unprovisioned connector', () => {
    const disabled = createProjection(
      { ...OPEN_ORG_POLICY, restrictedConnectors: ['webex'], disabledConnectors: ['webex'] },
      { ...EVERYTHING, allowedConnectors: ['webex'] }
    );
    expect(disabled.allows({ id: 'get_thread', connector: 'webex', kind: 'read' })).toBe(false);
    const unprovisioned = createProjection(
      { ...OPEN_ORG_POLICY, restrictedConnectors: ['webex'] },
      { provisionedConnectors: ['jira'], hiddenCapabilities: [], allowedConnectors: ['webex'] }
    );
    expect(unprovisioned.allows({ id: 'get_thread', connector: 'webex', kind: 'read' })).toBe(
      false
    );
  });
});
