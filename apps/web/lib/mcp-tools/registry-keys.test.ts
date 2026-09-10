/**
 * The catalog must know every connector the registry can mount.
 *
 * A capability key the registry gates on but the catalog does not list is a
 * connector nobody can switch off, scope to an audience, or see labelled —
 * `sandbox` and `batch-jobs` shipped exactly that way, and WebEx registered
 * under a key the catalog had never heard of, so its off switch did nothing.
 * Reading the registry's own list here means adding a namespace without a
 * catalog entry fails the suite rather than the admin.
 *
 * The mocks exist only so `registry.ts` can be imported: registration code
 * pulls in every tool module, and several of those touch kysely or the
 * database at module scope. Nothing here runs a query.
 */

jest.mock('kysely', () => ({
  sql: Object.assign(() => ({ as: () => ({}) }), {
    raw: () => ({}),
    join: () => ({}),
    ref: () => ({}),
    lit: () => ({}),
  }),
}));

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  },
  secure: (value: unknown) => value,
}));

jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: false, err: 'DB_ERROR' }) }));

jest.mock('@renkei/settings', () => ({
  getOrgSettings: async () => ({ ok: true, val: { readOnly: false, disabledConnectors: [] } }),
}));

jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: async () => null,
  searchKnowledge: jest.fn(),
  listRecentKnowledge: jest.fn(),
}));

import { REGISTERED_CONNECTOR_KEYS } from './registry';
import { togglableConnectors, CONNECTOR_CATALOG } from '@/lib/connector-catalog';
import { connectorKeyForTool } from './tool-connector';

describe('registered connector keys', () => {
  it('are all in the catalog, so each can be switched off and scoped', () => {
    const catalog = new Set(togglableConnectors().map((entry) => entry.capabilityKey));
    const missing = REGISTERED_CONNECTOR_KEYS.filter((key) => !catalog.has(key));
    expect(missing).toEqual([]);
  });

  it('gate WebEx under the key the catalog and the off switch use', () => {
    // The regression this file exists for: the gate used the CONFIG key
    // ('webex-user'), the catalog the capability key ('webex'), and
    // disabling WebEx silently did nothing.
    expect(REGISTERED_CONNECTOR_KEYS).toContain('webex');
    expect(REGISTERED_CONNECTOR_KEYS).not.toContain('webex-user');
  });

  it('match what connectorKeyForTool derives from each catalog tool prefix', () => {
    // A prefix that maps to a key the registry never mounts is a display
    // grouping pointing at nothing; usage rows would file under it forever.
    const registered = new Set(REGISTERED_CONNECTOR_KEYS);
    for (const entry of CONNECTOR_CATALOG.filter((e) => e.togglable)) {
      for (const prefix of entry.toolPrefix.split(',')) {
        const sample = prefix.trim().replace(/\*$/, 'sample');
        expect({ sample, key: connectorKeyForTool(sample) }).toEqual({
          sample,
          key: entry.capabilityKey,
        });
        expect(registered.has(entry.capabilityKey)).toBe(true);
      }
    }
  });
});
