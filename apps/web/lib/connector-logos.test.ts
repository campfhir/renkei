/**
 * Every mark the UI asks for must exist on disk.
 *
 * `ConnectorIcon` falls back to a built-in glyph when a file 404s, which is
 * the right behaviour and also why this test earns its place: a renamed or
 * deleted SVG produces no error, no warning and no failing build — just a
 * card that quietly shows a lettered tile instead of a logo, in production,
 * for everyone. That has already happened once (`atlassian-confluence.svg`
 * was replaced by `confluence.svg`), and nothing caught it.
 *
 * The separation between filenames and capability keys is checked here too,
 * from the other direction: `LOGO_FILE` should hold only genuine mismatches.
 * A stale entry pointing at a file that no longer exists is the same silent
 * failure with an extra step.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONNECTOR_CATALOG } from './connector-catalog';
import { MICROSOFT_PRODUCTS } from './microsoft-products';
import { LOGO_FILE, EXTRA_LOGOS, GLYPH_ONLY, resolveLogoFile } from './connector-logos';

const LOGO_DIR = resolve(__dirname, '../public/connector-logos');

const hasFile = (name: string) => existsSync(join(LOGO_DIR, `${name}.svg`));

describe('connector logo files', () => {
  it('ships a mark for every connector in the catalog', () => {
    const missing = CONNECTOR_CATALOG.map((entry) => resolveLogoFile(entry.capabilityKey))
      .filter((file) => !GLYPH_ONLY.has(file))
      .filter((file) => !hasFile(file));

    expect([...new Set(missing)]).toEqual([]);
  });

  it('ships a mark for every product panel', () => {
    // These pass an explicit logo, so the catalog check above cannot see them.
    const missing = MICROSOFT_PRODUCTS.map((product) =>
      resolveLogoFile(product.capabilityKey, product.logo)
    )
      .filter((file) => !GLYPH_ONLY.has(file))
      .filter((file) => !hasFile(file));

    expect([...new Set(missing)]).toEqual([]);
  });

  it('ships no file for the marks it means to draw itself', () => {
    // A file appearing under one of these names would silently win over the
    // glyph — and for 'directory' that would put the Microsoft mark back on a
    // panel inside the Microsoft card.
    expect([...GLYPH_ONLY].filter((file) => hasFile(file))).toEqual([]);
  });

  it('ships every mark requested outside the catalog', () => {
    expect(EXTRA_LOGOS.filter((file) => !hasFile(file))).toEqual([]);
  });

  it('maps only keys whose own-named file is absent', () => {
    // An entry for a key that HAS its own file is dead weight at best, and at
    // worst silently overrides a mark someone just added under the key's name.
    const pointless = Object.keys(LOGO_FILE).filter((key) => hasFile(key));
    expect(pointless).toEqual([]);
  });

  it('maps to files that exist', () => {
    const broken = Object.entries(LOGO_FILE).filter(([, file]) => !hasFile(file));
    expect(broken).toEqual([]);
  });

  it('does not rename capability keys to match filenames', () => {
    // The guard on the actual hazard: capabilityKey is persisted as
    // disabledConnectors, so if this key ever becomes 'confluence' to match
    // its file, every org that disabled Confluence silently gets it back.
    const confluence = CONNECTOR_CATALOG.find((entry) => entry.label === 'Confluence');
    expect(confluence?.capabilityKey).toBe('atlassian-confluence');
    expect(resolveLogoFile('atlassian-confluence')).toBe('confluence');
  });

  it('leaves no orphaned assets undocumented', () => {
    // Not a failure — vendors ship -gray/-white variants we stage for later.
    // This just keeps the set visible, so an asset nobody references is a
    // decision rather than an accident. (bitbucket.svg sat here staged until
    // the Bitbucket connector landed and started referencing it.)
    const referenced = new Set([
      ...CONNECTOR_CATALOG.map((entry) => resolveLogoFile(entry.capabilityKey)),
      ...MICROSOFT_PRODUCTS.map((product) => resolveLogoFile(product.capabilityKey, product.logo)),
      ...EXTRA_LOGOS,
    ]);
    const orphans = readdirSync(LOGO_DIR)
      .filter((file) => file.endsWith('.svg'))
      .map((file) => file.replace(/\.svg$/, ''))
      .filter((name) => !referenced.has(name));

    expect(orphans.sort()).toEqual([
      'atlassian-gray',
      'atlassian-white',
      'bitbucket-gray',
      'bitbucket-white',
    ]);
  });
});
