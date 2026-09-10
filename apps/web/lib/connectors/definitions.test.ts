/**
 * The admin catalog must be able to reach every connector's configuration.
 *
 * Jest does not load the definitions module itself (it imports the client
 * forms), so this checks the two things a person forgets from the outside:
 * every admin API directory under /api/admin/[slug]/connectors has a
 * catalog entry to hang its page on, and the definitions module binds a
 * form to it. A form with no binding is a page that 404s; a binding with no
 * route is a form whose save goes nowhere.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';

const API_DIR = resolve(__dirname, '../../app/api/admin/[slug]/connectors');
const FORMS_DIR = resolve(__dirname, '../../app/[slug]/admin/connectors/forms');
const DEFINITIONS = readFileSync(resolve(__dirname, 'definitions.tsx'), 'utf8');

const apiConfigKeys = () =>
  readdirSync(API_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

/** The keys the FORMS map in definitions.tsx binds, read off its source. */
function boundFormKeys(): string[] {
  const block = DEFINITIONS.slice(
    DEFINITIONS.indexOf('const FORMS'),
    DEFINITIONS.indexOf('};', DEFINITIONS.indexOf('const FORMS'))
  );
  return [...block.matchAll(/^\s+'?([a-z0-9-]+)'?:\s/gm)].map((match) => match[1]);
}

describe('connector definitions', () => {
  it('has a catalog entry for every admin API route', () => {
    const catalogKeys = new Set(CONNECTOR_CATALOG.map((entry) => entry.configKey));
    expect(apiConfigKeys().filter((key) => !catalogKeys.has(key))).toEqual([]);
  });

  it('binds a form to every admin API route, and a route to every form', () => {
    expect([...boundFormKeys()].sort()).toEqual([...apiConfigKeys()].sort());
  });

  it('keeps every form file referenced from the definitions', () => {
    const files = readdirSync(FORMS_DIR).filter(
      (file) => file.endsWith('-form.tsx') || file.endsWith('-forms.tsx')
    );
    const unreferenced = files.filter(
      (file) => !DEFINITIONS.includes(`/forms/${file.replace(/\.tsx$/, '')}'`)
    );
    expect(unreferenced).toEqual([]);
  });
});
