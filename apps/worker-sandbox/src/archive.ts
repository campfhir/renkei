/**
 * What this sandbox holds, as one compressed stream, and back again.
 *
 * A sandbox nothing has called for a day is evicted
 * (docs/sandbox-orchestrator-design.md): the orchestrator asks this
 * worker for an archive of what it holds, keeps it in the blob store,
 * and removes the machine. The next call for the scope makes a new
 * machine, and the orchestrator hands this worker's successor the
 * archive to unpack before anyone is served.
 *
 * What it holds is the two disks: the staged files (SANDBOX_DATA_DIR)
 * and the checkouts with each caller's home (SANDBOX_WORKSPACES_DIR).
 * Everything else about the scope is rows in Postgres, which name those
 * files by the same paths — which is why an archive is unpacked at the
 * paths it was packed from, with every owner and mode as it was (a
 * checkout is its caller's uid's, mode 0700).
 *
 * The stream is a tar, compressed with Zstandard: source trees and
 * dependency directories compress to a fraction, at a speed that does
 * not hold an eviction up. `tar` is the system's (GNU tar): it carries
 * owners, modes, symlinks and hard links exactly, which is the point.
 *
 * Unpacking writes as this process — root, in the image — so it takes
 * only the members under the two roots, never an absolute path or one
 * that climbs out (tar refuses those itself), and the archive comes from
 * the orchestrator, which made it from a sandbox of this same scope.
 *
 * Only an orchestrated sandbox does either: on a worker many callers
 * share, "what this worker holds" is everyone's.
 */

import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';

export const ARCHIVE_CONTENT_TYPE = 'application/zstd';

/** A root as tar names it: its path below `/`. */
function member(root: string): string {
  const absolute = resolve(root);
  if (!isAbsolute(absolute) || absolute === '/') {
    throw new Error(`not a directory an archive can hold: ${root}`);
  }
  return relative('/', absolute);
}

function stderrOf(child: { stderr: Readable | null }): () => string {
  const chunks: Buffer[] = [];
  let kept = 0;
  child.stderr?.on('data', (chunk: Buffer) => {
    // The last few kilobytes are what says why.
    if (kept < 8_192) {
      chunks.push(chunk);
      kept += chunk.length;
    }
  });
  return () => Buffer.concat(chunks).toString('utf8').trim();
}

function exited(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolveExit(code ?? -1));
  });
}

/**
 * Pack `roots` into `output` as a Zstandard-compressed tar. Resolves
 * when the whole archive has been written; rejects — with the stream cut
 * short, so the receiver knows — when tar could not read something.
 */
export async function writeArchive(roots: string[], output: Writable): Promise<void> {
  // A root that is not there must fail the archive, not shrink it: an
  // archive of nothing would stand in for the work on the next restore.
  for (const root of roots) {
    const found = await stat(root).catch(() => null);
    if (!found?.isDirectory()) {
      throw new Error(`tar could not pack the sandbox: ${root} is not a directory`);
    }
  }
  const tar = spawn(
    'tar',
    [
      '--create',
      '--file=-',
      '--numeric-owner',
      '--one-file-system',
      // A file that changes or goes while it is read is not a failed archive.
      '--warning=no-file-changed',
      '--warning=no-file-removed',
      '--ignore-failed-read',
      '--directory=/',
      '--',
      ...roots.map(member),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const said = stderrOf(tar);
  const done = exited(tar);
  if (!tar.stdout) throw new Error('tar gave no output stream');
  await pipeline(tar.stdout, createZstdCompress(), output);
  const code = await done;
  // 1: "some files differ" — a file changed as it was read. 2 and up: fatal.
  if (code !== 0 && code !== 1) {
    throw new Error(
      `tar could not pack the sandbox (exit ${code}): ${said() || 'no reason given'}`
    );
  }
}

/**
 * Unpack an archive made by `writeArchive` back under `roots`, owners
 * and modes as they were. Members outside the roots are not taken.
 */
export async function readArchive(roots: string[], input: Readable): Promise<void> {
  for (const root of roots) await mkdir(root, { recursive: true });
  const tar = spawn(
    'tar',
    [
      '--extract',
      '--file=-',
      '--numeric-owner',
      '--preserve-permissions',
      '--same-owner',
      '--directory=/',
      '--',
      ...roots.map(member),
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  );
  const said = stderrOf(tar);
  const done = exited(tar);
  if (!tar.stdin) throw new Error('tar took no input stream');
  // tar closing its input early (a bad archive) must not hang the pipeline.
  tar.stdin.on('error', () => undefined);
  try {
    await pipeline(input, createZstdDecompress(), tar.stdin);
  } catch (error) {
    tar.kill('SIGKILL');
    await done.catch(() => undefined);
    throw new Error(
      `the archive could not be read: ${error instanceof Error ? error.message : String(error)}${said() ? ` (${said()})` : ''}`,
      { cause: error }
    );
  }
  const code = await done;
  if (code !== 0) {
    throw new Error(
      `tar could not unpack the archive (exit ${code}): ${said() || 'no reason given'}`
    );
  }
}
