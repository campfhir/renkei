#!/usr/bin/env node
// Is the Node runtime inside the base images pinned in docker/Dockerfile
// behind the latest release of its major line?
//
// Node is installed from a tarball in the official image, so neither
// `apk upgrade` nor Trivy sees it: a Node security release reaches us only
// through a new base digest. This reads NODE_VERSION from the image
// configuration behind each pinned `node:<tag>@sha256:<digest>` (Docker Hub's
// registry API, anonymous token) and compares it with the newest release of
// the same major in https://nodejs.org/dist/index.json. Exit 1 when any
// pinned image is behind.
//
//   node scripts/check-node-version.mjs [path/to/Dockerfile]
//
// The network is injected (`fetchFn`) so the unit test runs on a stub.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry-1.docker.io';
const AUTH = 'https://auth.docker.io/token?service=registry.docker.io';
const NODE_INDEX = 'https://nodejs.org/dist/index.json';
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** Every distinct `node:<tag>@sha256:<digest>` the Dockerfile builds FROM. */
export function parseNodeImages(dockerfile) {
  const seen = new Map();
  for (const line of dockerfile.split('\n')) {
    const match =
      /^\s*FROM\s+(?:docker\.io\/library\/)?node:([A-Za-z0-9._-]+)@(sha256:[0-9a-f]{64})\b/i.exec(
        line
      );
    if (match) seen.set(`${match[1]}@${match[2]}`, { tag: match[1], digest: match[2] });
  }
  return [...seen.values()];
}

/** `24.21.0` from `v24.21.0`, else null. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text).trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`not a version: ${!left ? a : b}`);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

/** The newest release of `major` in nodejs.org's index.json entries. */
export function latestOfMajor(index, major) {
  let best = null;
  for (const entry of index) {
    const version = typeof entry?.version === 'string' ? entry.version : '';
    const parsed = parseVersion(version);
    if (!parsed || parsed[0] !== major) continue;
    if (best === null || compareVersions(version, best) > 0) best = version.replace(/^v/, '');
  }
  return best;
}

async function getJson(fetchFn, url, headers = {}) {
  const answer = await fetchFn(url, { headers });
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
  return answer.json();
}

/** NODE_VERSION in the image configuration behind a pinned digest. */
export async function nodeVersionOfImage(fetchFn, digest) {
  const token = (await getJson(fetchFn, `${AUTH}&scope=repository:library/node:pull`)).token;
  if (typeof token !== 'string' || !token) throw new Error('the registry gave no token');
  const headers = { authorization: `Bearer ${token}`, accept: MANIFEST_TYPES };
  const get = (kind, ref) =>
    getJson(fetchFn, `${REGISTRY}/v2/library/node/${kind}/${ref}`, headers);

  let manifest = await get('manifests', digest);
  if (Array.isArray(manifest.manifests)) {
    // A multi-platform index: every platform carries the same NODE_VERSION, so one will do.
    const amd64 = manifest.manifests.find(
      (entry) => entry.platform?.os === 'linux' && entry.platform?.architecture === 'amd64'
    );
    if (!amd64) throw new Error(`${digest} has no linux/amd64 manifest`);
    manifest = await get('manifests', amd64.digest);
  }
  const configDigest = manifest.config?.digest;
  if (typeof configDigest !== 'string') throw new Error(`${digest} has no image configuration`);
  const config = await get('blobs', configDigest);
  const env = Array.isArray(config.config?.Env) ? config.config.Env : [];
  const line = env.find((entry) => typeof entry === 'string' && entry.startsWith('NODE_VERSION='));
  if (!line) throw new Error(`${digest} sets no NODE_VERSION`);
  return line.slice('NODE_VERSION='.length);
}

/**
 * Compare each pinned image with the latest release of its major.
 * Returns `{ results, behind }`; `behind` is true when any image is.
 */
export async function check({ dockerfile, fetchFn }) {
  const images = parseNodeImages(dockerfile);
  if (images.length === 0)
    throw new Error('no node:<tag>@sha256 base image found in the Dockerfile');
  const index = await getJson(fetchFn, NODE_INDEX);
  const results = [];
  for (const image of images) {
    const pinned = await nodeVersionOfImage(fetchFn, image.digest);
    const parsed = parseVersion(pinned);
    if (!parsed) throw new Error(`${image.tag}: unreadable NODE_VERSION ${pinned}`);
    const latest = latestOfMajor(index, parsed[0]);
    if (!latest) throw new Error(`${image.tag}: no ${parsed[0]}.x release in the Node index`);
    results.push({ ...image, pinned, latest, behind: compareVersions(pinned, latest) < 0 });
  }
  return { results, behind: results.some((entry) => entry.behind) };
}

async function main() {
  const file = process.argv[2] ?? path.join(ROOT, 'docker/Dockerfile');
  const { results, behind } = await check({
    dockerfile: readFileSync(file, 'utf8'),
    fetchFn: fetch,
  });
  for (const entry of results) {
    const status = entry.behind ? 'BEHIND' : 'current';
    console.log(`node:${entry.tag} pins ${entry.pinned}; latest ${entry.latest} (${status})`);
  }
  if (behind) {
    console.error(
      'A pinned base image is behind the latest Node release: bump the digests in docker/Dockerfile.'
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
