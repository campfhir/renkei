import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check,
  compareVersions,
  latestOfMajor,
  nodeVersionOfImage,
  parseNodeImages,
  parseVersion,
} from './check-node-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D1 = `sha256:${'a'.repeat(64)}`;
const D2 = `sha256:${'b'.repeat(64)}`;
const PLATFORM = `sha256:${'c'.repeat(64)}`;
const CONFIG = `sha256:${'d'.repeat(64)}`;

const DOCKERFILE = [
  `FROM node:24-alpine@${D1} AS builder`,
  `FROM node:24-alpine@${D1} AS runtime`,
  `FROM node:24-bookworm-slim@${D2} AS sandbox`,
  'FROM scratch',
].join('\n');

const INDEX = [
  { version: 'v27.0.0-alpha.0.0.0' },
  { version: 'v24.22.2' },
  { version: 'v24.22.1' },
  { version: 'v24.9.0' },
  { version: 'v22.30.0' },
];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A registry and a Node index: each digest maps to the NODE_VERSION its image reports. */
function stub(versions) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push(String(url));
    const target = String(url);
    if (target.startsWith('https://auth.docker.io/token')) return json({ token: 't0k' });
    if (target === 'https://nodejs.org/dist/index.json') return json(INDEX);
    assert.equal(init.headers?.authorization, 'Bearer t0k', `unauthenticated: ${target}`);
    const manifest = /\/manifests\/(sha256:[0-9a-f]+)$/.exec(target);
    if (manifest) {
      const digest = manifest[1];
      if (versions[digest] !== undefined) {
        // A multi-platform index, arm64 first, as the registry lists them.
        return json({
          manifests: [
            {
              digest: `sha256:${'e'.repeat(64)}`,
              platform: { os: 'linux', architecture: 'arm64' },
            },
            {
              digest: PLATFORM + digest.slice(-1),
              platform: { os: 'linux', architecture: 'amd64' },
            },
          ],
        });
      }
      return json({ config: { digest: CONFIG + digest.slice(-1) } });
    }
    const blob = /\/blobs\/sha256:d{64}(.)$/.exec(target);
    if (blob) {
      const digest = Object.keys(versions).find((key) => key.endsWith(blob[1]));
      return json({ config: { Env: ['PATH=/usr/bin', `NODE_VERSION=${versions[digest]}`] } });
    }
    return json({ errors: [] }, 404);
  };
  return { fetchFn, calls };
}

test('base images are read from the FROM lines, once each', () => {
  assert.deepEqual(parseNodeImages(DOCKERFILE), [
    { tag: '24-alpine', digest: D1 },
    { tag: '24-bookworm-slim', digest: D2 },
  ]);
});

test('every node image in the real Dockerfile is digest-pinned', () => {
  const source = readFileSync(path.join(ROOT, 'docker/Dockerfile'), 'utf8');
  const froms = source
    .split('\n')
    .filter((line) => /^FROM\s+(docker\.io\/library\/)?node:/.test(line));
  assert.ok(froms.length > 0);
  assert.ok(parseNodeImages(source).length > 0);
  for (const line of froms) assert.match(line, /@sha256:[0-9a-f]{64}/);
});

test('versions compare numerically, not as text', () => {
  assert.deepEqual(parseVersion('v24.21.0'), [24, 21, 0]);
  assert.equal(parseVersion('24.21'), null);
  assert.ok(compareVersions('24.9.0', '24.21.0') < 0);
  assert.ok(compareVersions('24.22.2', '24.22.1') > 0);
  assert.equal(compareVersions('v24.1.0', '24.1.0'), 0);
});

test('the latest of a major ignores other majors and prereleases', () => {
  assert.equal(latestOfMajor(INDEX, 24), '24.22.2');
  assert.equal(latestOfMajor(INDEX, 22), '22.30.0');
  assert.equal(latestOfMajor(INDEX, 99), null);
});

test('NODE_VERSION comes from the amd64 image configuration behind the digest', async () => {
  const { fetchFn } = stub({ [D1]: '24.21.0' });
  assert.equal(await nodeVersionOfImage(fetchFn, D1), '24.21.0');
});

test('an image behind the latest 24.x release fails the check', async () => {
  const { fetchFn } = stub({ [D1]: '24.21.0', [D2]: '24.22.2' });
  const { results, behind } = await check({ dockerfile: DOCKERFILE, fetchFn });
  assert.equal(behind, true);
  assert.deepEqual(
    results.map(({ tag, pinned, latest, behind: late }) => [tag, pinned, latest, late]),
    [
      ['24-alpine', '24.21.0', '24.22.2', true],
      ['24-bookworm-slim', '24.22.2', '24.22.2', false],
    ]
  );
});

test('images on the latest release pass', async () => {
  const { fetchFn } = stub({ [D1]: '24.22.2', [D2]: '24.22.2' });
  assert.equal((await check({ dockerfile: DOCKERFILE, fetchFn })).behind, false);
});

test('a registry failure is an error, not a pass', async () => {
  const fetchFn = async (url) =>
    String(url).includes('nodejs.org') ? json(INDEX) : json({ errors: [] }, 429);
  await assert.rejects(check({ dockerfile: DOCKERFILE, fetchFn }), /429/);
});

test('a Dockerfile with no pinned node image is an error', async () => {
  await assert.rejects(
    check({ dockerfile: 'FROM alpine:3', fetchFn: stub({}).fetchFn }),
    /no node:<tag>@sha256/
  );
});
