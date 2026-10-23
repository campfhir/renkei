/**
 * The model's hands on a project's artifacts beyond reading one
 * (attachment-tools.ts, chat_read_attachment):
 *
 *   - artifact_search: the passages across the project's on-demand
 *     artifacts (and the chat's own files) that match a question, so a
 *     48-page guide is consulted, not read end to end. Lexical: each
 *     file's extracted text is cut into windows and scored by the query's
 *     terms; the best windows come back with where they sit, so a follow-up
 *     chat_read_attachment can read on from there. No index to build and
 *     nothing to be out of date; the org's knowledge index is for
 *     connector content and stays separate.
 *   - artifact_attach: keeps a file of this chat — one the person dropped,
 *     or one a tool wrote — as a project artifact, so every chat in the
 *     project has it from now on.
 *   - artifact_share: lets a person use an artifact the chat's owner owns.
 *
 * Attaching and sharing are the person's acts done on their say-so; both
 * refuse under read-only mode, and both go through artifact-library.ts
 * exactly as the page's buttons do.
 */

import {
  getAttachmentText,
  listAttachments,
  listProjectArtifacts,
  type AttachmentRow,
} from './attachments';
import { resolveArtifactAccess } from './artifact-access';
import { attachToProject, shareArtifact } from './artifact-library';
import { errorResult, textResult, type LocalTool, type LocalToolContext } from './local-tools';

const WINDOW_CHARS = 1_200;
const WINDOW_STEP = 600;
const DEFAULT_HITS = 6;
const MAX_HITS = 12;
/** How many files one search opens; a project rarely holds more that are worth searching. */
const MAX_FILES = 40;

export interface Passage {
  artifactId: string;
  filename: string;
  offset: number;
  text: string;
  score: number;
}

/** The query's terms: lower-cased words of two or more characters, de-duplicated. */
export function termsOf(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_.-]+/u)
        .map((term) => term.replace(/^[.-]+|[.-]+$/g, ''))
        .filter((term) => term.length >= 2)
    ),
  ];
}

/**
 * The best windows of one text for the terms: a window scores by how
 * many distinct terms it holds (weighted most), then by how often, with a
 * small bonus for the exact phrase. Overlapping windows collapse to the
 * better one.
 */
export function scoreText(
  text: string,
  terms: string[],
  phrase: string
): { offset: number; score: number }[] {
  if (terms.length === 0 || text.length === 0) return [];
  const lower = text.toLowerCase();
  const hits: { offset: number; score: number }[] = [];
  for (let offset = 0; offset < lower.length; offset += WINDOW_STEP) {
    const window = lower.slice(offset, offset + WINDOW_CHARS);
    let distinct = 0;
    let total = 0;
    for (const term of terms) {
      let count = 0;
      let at = window.indexOf(term);
      while (at !== -1 && count < 20) {
        count += 1;
        at = window.indexOf(term, at + term.length);
      }
      if (count > 0) {
        distinct += 1;
        total += count;
      }
    }
    if (distinct === 0) continue;
    const score =
      distinct * 10 + Math.min(total, 30) + (phrase.length > 3 && window.includes(phrase) ? 15 : 0);
    hits.push({ offset, score });
    if (offset + WINDOW_CHARS >= lower.length) break;
  }
  hits.sort((a, b) => b.score - a.score || a.offset - b.offset);
  const kept: { offset: number; score: number }[] = [];
  for (const hit of hits) {
    if (kept.some((other) => Math.abs(other.offset - hit.offset) < WINDOW_CHARS)) continue;
    kept.push(hit);
  }
  return kept;
}

/** The files a search covers: the project's on-demand artifacts, then the chat's own files. */
async function searchableFiles(context: LocalToolContext): Promise<AttachmentRow[]> {
  const own = await listAttachments(context.db, { chatId: context.chatId });
  if (!context.projectId) return own;
  const held = await listProjectArtifacts(context.db, context.projectId);
  // "Always" artifacts are in the prompt already; searching them again adds nothing.
  return [
    ...held.filter((row) => row.mode !== 'always'),
    ...own.filter((row) => !held.some((h) => h.id === row.id)),
  ];
}

export async function searchArtifacts(
  context: LocalToolContext,
  query: string,
  limit: number,
  onlyIds: string[] | null
): Promise<{ passages: Passage[]; searched: number; unreadable: string[] }> {
  const terms = termsOf(query);
  const phrase = query.trim().toLowerCase();
  const files = (await searchableFiles(context))
    .filter((row) => row.extractStatus === 'done')
    .filter((row) => !onlyIds || onlyIds.includes(row.id))
    .slice(0, MAX_FILES);
  const passages: Passage[] = [];
  const unreadable: string[] = [];
  for (const row of files) {
    const cipher =
      row.keyKind === 'chat' && row.keyRef === context.chatId
        ? context.cipher
        : ((await resolveArtifactAccess(context.db, context.subject, row, context.projectId))
            ?.cipher ?? null);
    const text = cipher ? await getAttachmentText(context.db, row.id, cipher) : null;
    if (!text || text.startsWith('[content unavailable')) {
      unreadable.push(row.filename);
      continue;
    }
    for (const hit of scoreText(text, terms, phrase).slice(0, limit)) {
      passages.push({
        artifactId: row.id,
        filename: row.filename,
        offset: hit.offset,
        text: text.slice(hit.offset, hit.offset + WINDOW_CHARS),
        score: hit.score,
      });
    }
  }
  passages.sort((a, b) => b.score - a.score);
  return { passages: passages.slice(0, limit), searched: files.length, unreadable };
}

export function artifactSearchTool(): LocalTool {
  return {
    def: {
      name: 'artifact_search',
      description:
        "Find the passages in this project's artifacts (and this chat's files) that match a question — manuals, guides, design docs — before reading one in full. Returns the best-matching excerpts with the file and character offset each sits at; read on from an offset with chat_read_attachment.",
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to look for: the terms a passage would contain, not a sentence.',
          },
          artifactIds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Search only these files (ids from the project artifacts list); all by default.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_HITS,
            description: `Passages to return (default ${DEFAULT_HITS}).`,
          },
        },
        required: ['query'],
      },
    },
    readOnly: true,
    async execute(input, context) {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!query) return errorResult('Say what to search for.');
      const limit =
        typeof input.limit === 'number' && input.limit > 0
          ? Math.min(MAX_HITS, Math.floor(input.limit))
          : DEFAULT_HITS;
      const onlyIds = Array.isArray(input.artifactIds)
        ? input.artifactIds.filter((id): id is string => typeof id === 'string')
        : null;
      const result = await searchArtifacts(context, query, limit, onlyIds);
      if (result.searched === 0) {
        return textResult('No artifacts with extracted text to search in this project or chat.');
      }
      const lines = result.passages.map(
        (passage, index) =>
          `[${index + 1}] ${passage.filename} (artifact id ${passage.artifactId}, offset ${passage.offset})\n${passage.text.trim()}`
      );
      const note =
        result.unreadable.length > 0 ? `\n\nCould not open: ${result.unreadable.join(', ')}.` : '';
      return textResult(
        result.passages.length === 0
          ? `Nothing in ${result.searched} file(s) matched "${query}". Try other terms.${note}`
          : `${result.passages.length} passage(s) from ${result.searched} file(s):\n\n${lines.join('\n\n')}${note}`
      );
    },
  };
}

export function artifactAttachTool(): LocalTool {
  return {
    def: {
      name: 'artifact_attach',
      description:
        "Keep a file of this chat — one the person uploaded, or one you wrote — as an artifact of this project, so every chat in the project can read it from now on. mode 'always' puts its full text in every turn (short guides and conventions); 'on_demand' (the default) leaves it to artifact_search and chat_read_attachment. Do this when the person asks for it.",
      inputSchema: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string' },
          mode: { type: 'string', enum: ['always', 'on_demand'] },
        },
        required: ['attachmentId'],
      },
    },
    readOnly: false,
    async execute(input, context) {
      if (context.readOnly) return errorResult('Read-only mode: nothing can be attached.');
      if (!context.projectId) return errorResult('This chat is not in a project.');
      const id = typeof input.attachmentId === 'string' ? input.attachmentId : '';
      const result = await attachToProject(context.db, {
        actorSubject: context.subject,
        artifactId: id,
        projectId: context.projectId,
        mode: input.mode === 'always' ? 'always' : 'on_demand',
      });
      if (!result.ok) {
        switch (result.err.type) {
          case 'BUDGET':
            return errorResult(
              "Keeping it in every turn would exceed the project's always-in-context budget; attach it on demand instead."
            );
          case 'INVALID':
            return errorResult(
              'That file has no extracted text, so it cannot be kept in context; attach it on demand.'
            );
          case 'FORBIDDEN':
            return errorResult('Only the project’s owner and editors can attach files to it.');
          case 'CONTENT_KEY':
            return errorResult(
              'The file could not be re-keyed for the project; its owner has to be signed in.'
            );
          default:
            return errorResult('No such file in this chat.');
        }
      }
      return textResult(
        `Attached to the project (${result.val.mode === 'always' ? 'kept in context every turn' : 'searched and read on demand'}).`
      );
    },
  };
}

export function artifactShareTool(): LocalTool {
  return {
    def: {
      name: 'artifact_share',
      description:
        "Share an artifact this person owns with a colleague, by email: they may then read it and use it in their own projects, not change it. Only when the person asks; find the colleague's email with the directory tools if you have only a name.",
      inputSchema: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['attachmentId', 'email'],
      },
    },
    readOnly: false,
    async execute(input, context) {
      if (context.readOnly) return errorResult('Read-only mode: nothing can be shared.');
      const id = typeof input.attachmentId === 'string' ? input.attachmentId : '';
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      if (!email) return errorResult('Say whose email to share with.');
      const person = await context.db
        .selectFrom('identities')
        .select(['subject', 'display_name'])
        .where('email', '=', email)
        .executeTakeFirst();
      if (!person) return errorResult(`Nobody in the directory has the email ${email}.`);
      const result = await shareArtifact(context.db, {
        ownerSubject: context.subject,
        artifactId: id,
        granteeSubject: person.subject,
        expiresAt: null,
      });
      if (!result.ok) {
        switch (result.err.type) {
          case 'SELF':
            return errorResult('That is the person themselves.');
          case 'CONTENT_KEY':
            return errorResult(
              'The file could not be re-keyed for sharing; try again once signed in.'
            );
          default:
            return errorResult('No such artifact of yours. Only the owner of a file can share it.');
        }
      }
      return textResult(
        `Shared with ${person.display_name ?? email}; they can use it in their own projects.`
      );
    },
  };
}

export function artifactTools(input: { inProject: boolean }): LocalTool[] {
  return input.inProject
    ? [artifactSearchTool(), artifactAttachTool(), artifactShareTool()]
    : [artifactSearchTool(), artifactShareTool()];
}
