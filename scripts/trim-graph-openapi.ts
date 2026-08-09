/**
 * Vendor a TRIMMED Microsoft Graph v1.0 OpenAPI spec into docs/.
 *
 * The official spec is a single ~50MB YAML covering every Graph workload —
 * far too much to commit or to read. This keeps only the paths the Outlook
 * connector touches (mail, calendar, To Do, subscriptions, identity) and
 * the component schemas they reference.
 *
 * The schema graph is the hard part: microsoft.graph.* entities reference
 * each other so densely that a full transitive closure pulls in half the
 * spec. So the closure is BOUNDED — schemas up to SCHEMA_DEPTH hops from a
 * kept path are kept whole; a reference that crosses the boundary is
 * replaced with a `{type: "object"}` stub naming what was trimmed. Non-
 * schema components (parameters, responses, …) are small and kept whenever
 * reachable without consuming depth.
 *
 * Run:  pnpm exec tsx scripts/trim-graph-openapi.ts
 * The raw download is cached in the OS temp dir; delete it to force a
 * refresh. Idempotent — re-run when Microsoft updates the spec and review
 * the diff before committing.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const SOURCE_URL =
  'https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/openapi/v1.0/openapi.yaml';
const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../docs/microsoft-graph-v1-open-api-spec.json'
);

/**
 * Paths kept exactly. The /users and /groups trees are enormous (teams,
 * planner, conversations…), so the directory tools' endpoints are listed
 * one by one instead of by prefix.
 */
const KEEP_EXACT = new Set([
  '/me',
  '/me/sendMail',
  '/users',
  '/users/{user-id}',
  '/users/{user-id}/manager',
  '/users/{user-id}/directReports',
  '/groups',
  '/groups/{group-id}',
  '/groups/{group-id}/members',
]);
/** Paths kept by prefix — the workloads the Outlook connector uses. */
const KEEP_PREFIXES = [
  '/me/messages',
  '/me/mailFolders',
  '/me/events',
  '/me/calendar',
  '/me/calendars', // boundary-checked matching means these are NOT covered
  '/me/calendarView', // by the /me/calendar prefix — list them explicitly
  '/me/todo',
  '/subscriptions',
];

/** How many schema-to-schema hops from a kept path survive the trim. */
const SCHEMA_DEPTH = 2;

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function keepPath(path: string): boolean {
  if (KEEP_EXACT.has(path)) return true;
  return KEEP_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}(`)
  );
}

/** Every `$ref` value under `node`, as `[section, name]` component pairs. */
function collectRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const entry of node) collectRefs(entry, into);
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/')) {
      into.add(value.slice('#/components/'.length)); // "schemas/microsoft.graph.message"
    } else {
      collectRefs(value, into);
    }
  }
}

/**
 * Deep-copy `node`, replacing objects that reference a schema OUTSIDE the
 * kept set with a stub. References to kept components pass through.
 */
function stubTrimmedRefs(node: unknown, keptSchemas: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((entry) => stubTrimmedRefs(entry, keptSchemas));
  if (!isRecord(node)) return node;

  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
    const name = ref.slice('#/components/schemas/'.length);
    if (!keptSchemas.has(name)) {
      return { type: 'object', description: `Trimmed from the vendored spec: ${name}` };
    }
  }

  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = stubTrimmedRefs(value, keptSchemas);
  }
  return out;
}

async function loadSource(): Promise<string> {
  const cachePath = join(tmpdir(), 'msgraph-openapi-v1.yaml');
  if (existsSync(cachePath)) {
    console.log(`Using cached download at ${cachePath}`);
    return readFileSync(cachePath, 'utf8');
  }
  console.log(`Downloading ${SOURCE_URL} (tens of MB — this takes a moment)…`);
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  const text = await response.text();
  writeFileSync(cachePath, text);
  console.log(`Cached raw spec at ${cachePath} (${(text.length / 1024 / 1024).toFixed(1)} MB)`);
  return text;
}

async function main(): Promise<void> {
  const text = await loadSource();
  console.log('Parsing YAML (large — be patient)…');
  const spec = parse(text, { maxAliasCount: -1 }) as Json;

  const allPaths = isRecord(spec.paths) ? spec.paths : {};
  const keptPaths: Json = {};
  for (const [path, item] of Object.entries(allPaths)) {
    if (keepPath(path)) keptPaths[path] = item;
  }
  console.log(`Paths: kept ${Object.keys(keptPaths).length} of ${Object.keys(allPaths).length}`);

  const components = isRecord(spec.components) ? spec.components : {};
  const schemas = isRecord(components.schemas) ? components.schemas : {};

  // Breadth-first over component references. Schema→schema edges consume
  // depth; everything else rides along free (those components are small).
  const keptSchemas = new Set<string>();
  const keptOther = new Map<string, Set<string>>(); // section -> names
  let frontier = new Set<string>();
  collectRefs(keptPaths, frontier);

  for (let depth = 0; depth <= SCHEMA_DEPTH; depth += 1) {
    const next = new Set<string>();
    for (const entry of frontier) {
      const [section, ...rest] = entry.split('/');
      const name = rest.join('/');
      if (!section || !name) continue;

      if (section === 'schemas') {
        if (keptSchemas.has(name)) continue;
        keptSchemas.add(name);
        if (depth < SCHEMA_DEPTH) collectRefs(schemas[name], next);
      } else {
        const names = keptOther.get(section) ?? new Set<string>();
        if (names.has(name)) continue;
        names.add(name);
        keptOther.set(section, names);
        const sectionObj = isRecord(components[section]) ? (components[section] as Json) : {};
        // Non-schema components do not consume depth, but their schema refs
        // enter the frontier at the CURRENT depth.
        collectRefs(sectionObj[name], next);
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }

  console.log(
    `Components: kept ${keptSchemas.size} of ${Object.keys(schemas).length} schemas, ` +
      `${[...keptOther.entries()].map(([s, n]) => `${n.size} ${s}`).join(', ') || 'no others'}`
  );

  const trimmedComponents: Json = {};
  const trimmedSchemas: Json = {};
  for (const name of [...keptSchemas].sort()) {
    if (name in schemas) trimmedSchemas[name] = stubTrimmedRefs(schemas[name], keptSchemas);
  }
  trimmedComponents.schemas = trimmedSchemas;
  for (const [section, names] of keptOther) {
    const sectionObj = isRecord(components[section]) ? (components[section] as Json) : {};
    const kept: Json = {};
    for (const name of [...names].sort()) {
      if (name in sectionObj) kept[name] = stubTrimmedRefs(sectionObj[name], keptSchemas);
    }
    trimmedComponents[section] = kept;
  }
  if (isRecord(components.securitySchemes)) {
    trimmedComponents.securitySchemes = components.securitySchemes;
  }

  const info = isRecord(spec.info) ? spec.info : {};
  const trimmed: Json = {
    openapi: spec.openapi,
    info: {
      ...info,
      title: `${String(info.title ?? 'Microsoft Graph v1.0')} (trimmed vendored copy)`,
      'x-renkei-vendored': {
        source: SOURCE_URL,
        retrieved: new Date().toISOString().slice(0, 10),
        keptPathPrefixes: [...KEEP_EXACT, ...KEEP_PREFIXES],
        schemaDepth: SCHEMA_DEPTH,
        note:
          'Regenerate with scripts/trim-graph-openapi.ts. Schema references beyond ' +
          'the depth bound are stubbed as {type: "object"} naming the trimmed type.',
      },
    },
    servers: spec.servers,
    paths: stubTrimmedRefs(keptPaths, keptSchemas),
    components: trimmedComponents,
  };

  const json = JSON.stringify(trimmed, null, 2);
  writeFileSync(OUTPUT, `${json}\n`);
  console.log(`Wrote ${OUTPUT} (${(json.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
