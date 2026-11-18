/**
 * The organization's CI building blocks, as the admin pages and the code
 * projects read them (the ciBlocks store domain; @renkei/ci-blocks says
 * what a definition is).
 *
 * A block is edited as a draft and published as a numbered version that
 * never changes afterwards; a pipeline built from v2 keeps v2 until
 * someone updates it. A draft is saved as it stands — half-finished work
 * is still work — and only a definition that reads whole is published.
 */

import { getDataStore, type CiBlockRecord } from '@renkei/db';
import { BLOCK_KINDS, readBlockDefinition, type BlockKind } from '@renkei/ci-blocks';
import { isRecord } from '@renkei/guards';
import { getIdentityDisplay } from '@/lib/identity';

export const BLOCK_KEY = /^[a-z][a-z0-9-]{1,79}$/;

export interface BlockSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: string;
  latestVersion: number;
  hasDraft: boolean;
  /** From the draft if there is one, else the latest version. */
  runsOn: 'hosted' | 'target' | null;
  image: string | null;
  /** Variable names it needs, a secured one marked "(secured)". */
  needs: string[];
  updatedAt: string;
}

export interface BlockVersionView {
  version: number;
  publishedBy: string;
  publishedAt: string;
}

export interface BlockDetail {
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: string;
  latestVersion: number;
  /** The definition being edited, or null. */
  draft: unknown;
  /** The latest published definition, or null before the first. */
  published: unknown;
  versions: BlockVersionView[];
}

export interface BlockPayload {
  key: string;
  name: string;
  description: string | null;
  kind: BlockKind;
  definition: unknown;
}

const blocks = () => getDataStore().ciBlocks;

/** Who published, as people know them: a name, else an email; the starter blocks are Renkei's own. */
async function personName(subject: string): Promise<string> {
  if (subject === 'renkei') return 'Renkei (a starter block)';
  const identity = await getIdentityDisplay(subject);
  return identity?.displayName || identity?.email || subject;
}

function summaryOf(record: CiBlockRecord, definition: unknown): BlockSummary {
  const def = isRecord(definition) ? definition : {};
  const runsOn = isRecord(def.runsOn) ? def.runsOn : {};
  const variables = Array.isArray(def.variables) ? def.variables : [];
  return {
    id: record.id,
    key: record.key,
    name: record.name,
    description: record.description,
    kind: record.kind,
    latestVersion: record.latestVersion,
    hasDraft: record.draft !== null,
    runsOn: runsOn.type === 'hosted' || runsOn.type === 'target' ? runsOn.type : null,
    image: runsOn.type === 'hosted' && typeof runsOn.image === 'string' ? runsOn.image : null,
    needs: variables.flatMap((v) =>
      isRecord(v) && typeof v.name === 'string'
        ? [`${v.name}${v.secured === true ? ' (secured)' : ''}`]
        : []
    ),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export async function listBlocks(): Promise<BlockSummary[]> {
  const records = await blocks().list();
  return Promise.all(
    records.map(async (record) => {
      if (record.draft !== null || record.latestVersion === 0)
        return summaryOf(record, record.draft);
      const latest = await blocks().getVersion(record.id, record.latestVersion);
      return summaryOf(record, latest?.definition ?? null);
    })
  );
}

export async function getBlock(id: string): Promise<BlockDetail | null> {
  const record = await blocks().get(id);
  if (!record) return null;
  const versions = await blocks().listVersions(id);
  return {
    id: record.id,
    key: record.key,
    name: record.name,
    description: record.description,
    kind: record.kind,
    latestVersion: record.latestVersion,
    draft: record.draft,
    published: versions[0]?.definition ?? null,
    versions: await Promise.all(
      versions.map(async (v) => ({
        version: v.version,
        publishedBy: await personName(v.publishedBy),
        publishedAt: v.publishedAt.toISOString(),
      }))
    ),
  };
}

/** A create or save body: the name and kind checked, the definition kept as given (a draft). */
export function parseBlockPayload(
  body: unknown,
  options: { create: boolean }
): BlockPayload | { error: string } {
  if (!isRecord(body)) return { error: 'Send the block as JSON.' };
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (options.create && !BLOCK_KEY.test(key)) {
    return {
      error:
        'The key is how pipelines name the block: lower case letters, digits and -, starting with a letter.',
    };
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 200) return { error: 'Give the block a name (up to 200 characters).' };
  const kind = BLOCK_KINDS.find((k) => k === body.kind);
  if (!kind) return { error: `Kind must be one of ${BLOCK_KINDS.join(', ')}.` };
  if (!isRecord(body.definition)) return { error: 'The block’s definition is missing.' };
  if (JSON.stringify(body.definition).length > 100_000)
    return { error: 'The definition is too large.' };
  const description =
    typeof body.description === 'string' && body.description.trim()
      ? body.description.trim().slice(0, 1000)
      : null;
  // The definition's own kind follows the block's.
  return { key, name, description, kind, definition: { ...body.definition, kind } };
}

const isTaken = (error: unknown) => isRecord(error) && error.code === '23505';

export async function createBlock(
  input: BlockPayload,
  subject: string
): Promise<{ ok: true; id: string } | { ok: false; error: 'taken' }> {
  try {
    const id = await blocks().create({
      key: input.key,
      name: input.name,
      description: input.description,
      kind: input.kind,
      draft: input.definition,
      createdBy: subject,
    });
    return { ok: true, id };
  } catch (error) {
    if (isTaken(error)) return { ok: false, error: 'taken' };
    throw error;
  }
}

export async function saveBlockDraft(id: string, input: BlockPayload): Promise<boolean> {
  return blocks().saveDraft(id, {
    name: input.name,
    description: input.description,
    kind: input.kind,
    draft: input.definition,
  });
}

export async function discardBlockDraft(id: string): Promise<boolean> {
  return blocks().discardDraft(id);
}

export type PublishOutcome =
  | { ok: true; version: number }
  | { ok: false; error: 'not-found' | 'nothing-to-publish' }
  | { ok: false; error: 'invalid'; problems: string[] };

/** The draft as the next version — only when it reads whole. */
export async function publishBlock(id: string, subject: string): Promise<PublishOutcome> {
  const record = await blocks().get(id);
  if (!record) return { ok: false, error: 'not-found' };
  if (record.draft === null) return { ok: false, error: 'nothing-to-publish' };
  const read = readBlockDefinition(record.draft);
  if (!read.ok) return { ok: false, error: 'invalid', problems: read.errors };
  const version = await blocks().publish(id, subject);
  return version === null ? { ok: false, error: 'nothing-to-publish' } : { ok: true, version };
}

export async function deleteBlock(id: string): Promise<{ name: string } | null> {
  const record = await blocks().get(id);
  if (!record) return null;
  return (await blocks().delete(id)) ? { name: record.name } : null;
}
