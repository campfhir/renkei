/**
 * Every card on the Connectors page shows its connector's mark beside its
 * heading. Cards render only for what the organization has set up, so a
 * browser run cannot see them all (e2e/connector-logos.spec.ts checks the
 * ones that render); this reads each card's source instead, so a card whose
 * heading lost its mark — Mirth Connect, File shares, ADManager Plus and
 * Browser secrets once had none — fails here whatever the org runs.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = __dirname;

/** Files that draw a card heading: a ConnectorHeading, or the secrets card's own <h2>. */
function cardFiles(): string[] {
  return readdirSync(DIR)
    .filter((file) => file.endsWith('.tsx') && file !== 'connector-shell.tsx')
    .filter((file) => {
      const source = readFileSync(join(DIR, file), 'utf8');
      return source.includes('<ConnectorHeading') || file === 'sandbox-secrets-body.tsx';
    });
}

describe('connector cards', () => {
  it('finds the cards', () => {
    expect(cardFiles()).toEqual(
      expect.arrayContaining([
        'mirth-connector.tsx',
        'fileshares-connector.tsx',
        'admanager-connector.tsx',
        'sandbox-secrets-body.tsx',
        'salesforce-connector.tsx',
        'github-connector.tsx',
      ])
    );
  });

  it('gives every card heading a connector mark', () => {
    const missing = cardFiles().filter(
      (file) => !readFileSync(join(DIR, file), 'utf8').includes('<ConnectorIcon')
    );
    expect(missing).toEqual([]);
  });
});
