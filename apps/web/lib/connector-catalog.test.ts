/**
 * The connector catalog and the disable dial it drives.
 *
 * The catalog's job is to keep three different "connector" identifiers
 * straight — the config row, the capability key, the grant provider — so
 * these tests mostly guard against those drifting back together.
 */

import { CONNECTOR_CATALOG, togglableConnectors } from './connector-catalog';
import { createProjection } from '@renkei/capability-registry';

describe('connector catalog', () => {
  it('lets several products share one config row', () => {
    // SharePoint, OneDrive and Outlook all ride the single Entra app, and
    // flattening that would imply three registrations that do not exist.
    const microsoftBacked = CONNECTOR_CATALOG.filter((entry) => entry.configKey === 'microsoft');
    expect(microsoftBacked.map((entry) => entry.capabilityKey).sort()).toEqual([
      'microsoft',
      'onedrive',
      'sharepoint',
    ]);
  });

  it('offers one switch per capability key, not per product', () => {
    // Jira and JSM share the 'jira' capability key, so the registry cannot
    // separate them — two toggles would promise a control that does not exist.
    const keys = togglableConnectors().map((entry) => entry.capabilityKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('jira');
    expect(keys.filter((key) => key === 'jira')).toHaveLength(1);
  });

  it('offers no switch for an entry that registers no tools', () => {
    // Mistral OCR is a pipeline stage: a toggle would promise a control
    // that does nothing. (Coverage of every key the registry DOES mount is
    // asserted from the registry's side, in mcp-tools/registry-keys.test.ts.)
    const keys = togglableConnectors().map((entry) => entry.capabilityKey);
    expect(keys).not.toContain('mistral-ocr');
    expect(CONNECTOR_CATALOG.some((entry) => entry.capabilityKey === 'mistral-ocr')).toBe(true);
  });

  it('keeps a shared config row within one suite', () => {
    // Outlook, SharePoint and OneDrive ride one Entra app; Jira and JSM ride
    // one capability key but separate apps. Either way, the products sharing
    // a config row must render inside the same composite card, or a person
    // would connect the same app twice from two places.
    const suiteOf = new Map<string, string | undefined>();
    for (const entry of CONNECTOR_CATALOG) {
      if (suiteOf.has(entry.configKey)) expect(suiteOf.get(entry.configKey)).toBe(entry.suite);
      suiteOf.set(entry.configKey, entry.suite);
    }
  });

  it('marks only self-service products as user-connectable', () => {
    // Renkei's own surfaces are provisioned org-wide, not added by a person.
    const personal = CONNECTOR_CATALOG.filter((entry) => entry.userConnectable);
    expect(personal.every((entry) => entry.category !== 'renkei')).toBe(true);
    expect(personal.map((entry) => entry.label)).toContain('File shares');
    expect(personal.map((entry) => entry.label)).not.toContain('Knowledge');
  });
});

describe('disabling a connector', () => {
  const projectionWith = (disabled: string[]) =>
    createProjection(
      {
        readOnly: false,
        disabledConnectors: disabled,
        disabledCapabilities: [],
        restrictedConnectors: [],
      },
      {
        provisionedConnectors: ['microsoft', 'sharepoint', 'onedrive'],
        hiddenCapabilities: [],
      }
    );

  it('hides only the named connector, leaving its siblings alone', () => {
    // The whole point of separate capability keys: SharePoint can go off
    // without taking mail — which shares its Entra app — with it.
    const projection = projectionWith(['sharepoint']);

    expect(
      projection.allows({ id: 'sharepoint_list_libraries', connector: 'sharepoint', kind: 'read' })
    ).toBe(false);
    expect(
      projection.allows({ id: 'outlook_list_messages', connector: 'microsoft', kind: 'read' })
    ).toBe(true);
    expect(
      projection.allows({ id: 'onedrive_list_folder', connector: 'onedrive', kind: 'read' })
    ).toBe(true);
  });

  it('hides reads as well as writes', () => {
    // Unlike read-only mode, which only takes away Act tools, this is an
    // off switch — a half-present connector would be worse than none.
    const projection = projectionWith(['sharepoint']);
    for (const kind of ['read', 'act'] as const) {
      expect(projection.allows({ id: 'sharepoint_x', connector: 'sharepoint', kind })).toBe(false);
    }
  });

  it('allows everything when nothing is disabled', () => {
    const projection = projectionWith([]);
    expect(
      projection.allows({ id: 'sharepoint_list_libraries', connector: 'sharepoint', kind: 'read' })
    ).toBe(true);
  });
});
