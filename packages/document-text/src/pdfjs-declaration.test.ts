/**
 * Every app that consumes this package must declare pdfjs-dist itself.
 *
 * This is a packaging invariant, so it is tested against package.json rather
 * than against behaviour — and it is tested at all because violating it is
 * invisible from inside this package. pdf.ts imports pdfjs by BARE SPECIFIER
 * inside a runtime `await import()`. Next.js compiles pdf.ts into the web
 * bundle (transpilePackages), so Node resolves that specifier from
 * apps/web/.next/server, which cannot see packages/document-text's own
 * node_modules. Declaring the dependency here alone is not enough for anyone
 * who bundles.
 *
 * What that looked like in production: every unit test passed, the worker
 * extracted PDFs correctly, and sharepoint_read_document told users that a
 * perfectly good PDF's "format cannot be read as text" — which reads as a
 * scanned document, so the report came back as a question about OCR rather
 * than a missing dependency.
 *
 * The version must be `catalog:` rather than a repeated literal so the pin
 * lives in exactly one place; two apps silently resolving different pdfjs
 * builds is the next version of this bug.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const APPS_DIR = resolve(__dirname, '../../../apps');

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
}

function readPackage(path: string): PackageJson {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsing our own manifest
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

function appManifests(): { name: string; pkg: PackageJson }[] {
  return readdirSync(APPS_DIR)
    .map((entry) => ({ name: entry, path: join(APPS_DIR, entry, 'package.json') }))
    .filter((entry) => existsSync(entry.path))
    .map((entry) => ({ name: entry.name, pkg: readPackage(entry.path) }));
}

describe('pdfjs-dist declaration', () => {
  const consumers = appManifests().filter(
    (app) => app.pkg.dependencies?.['@renkei/document-text'] !== undefined
  );

  it('finds the apps that consume this package', () => {
    // If this ever reads zero, the assertions below would pass vacuously and
    // guard nothing at all.
    expect(consumers.length).toBeGreaterThan(0);
  });

  it.each(consumers.map((app) => app.name))(
    'apps/%s declares pdfjs-dist so its runtime can resolve it',
    (name) => {
      const app = consumers.find((entry) => entry.name === name);
      expect(app?.pkg.dependencies?.['pdfjs-dist']).toBe('catalog:');
    }
  );

  it('keeps this package on the same catalog pin', () => {
    const own = readPackage(resolve(__dirname, '../package.json'));
    expect(own.dependencies?.['pdfjs-dist']).toBe('catalog:');
  });
});
