/**
 * The prompt library tools — the person's reusable prompts, kept from a
 * chat: list the libraries they can open and read a library's prompts,
 * make a library, save a prompt into one (a new one, or a change to one
 * that is there), and delete a prompt.
 *
 * Access is the shared resolver's, asked behind each tool whatever id the
 * model hands in (access.ts's resolveResourceAccess): a library the person
 * cannot open reads as "no such library", and one shared with them to
 * view cannot be written to — the rules the library's own routes hold
 * (app/api/chat/prompt-libraries/). Bodies are plaintext templates meant
 * for other people to read (prompts.ts). Everything but the listing acts,
 * so the chat asks first; deleting a library itself, which takes its
 * shares with it, stays on the library's page.
 */

import { isUuid } from '@/lib/uuid';
import { resolveResourceAccess } from '../access';
import { errorResult, textResult, type LocalTool, type LocalToolContext } from '../local-tools';
import {
  createLibrary,
  createPrompt,
  deletePrompt,
  getLibrary,
  listAccessibleLibraries,
  listPrompts,
  parseLibraryScope,
  updatePrompt,
  LIBRARY_NAME_MAX_CHARS,
  PROMPT_BODY_MAX_CHARS,
  PROMPT_TITLE_MAX_CHARS,
} from '../prompts';
import { optionalString } from '../route-support';
import { markdownLink } from './shared';

export const LIST_PROMPT_LIBRARIES_TOOL = 'renkei_list_prompt_libraries';
export const CREATE_PROMPT_LIBRARY_TOOL = 'renkei_create_prompt_library';
export const SAVE_PROMPT_TOOL = 'renkei_save_prompt';
export const DELETE_PROMPT_TOOL = 'renkei_delete_prompt';

const NO_SUCH_LIBRARY = `No such prompt library. Call ${LIST_PROMPT_LIBRARIES_TOOL} for the ones this person can open.`;

const libraryPath = (libraryId: string) => `/chat/prompts/${libraryId}`;

/** The library, if this person may open it; with `write`, only if they may change it. */
async function openLibrary(context: LocalToolContext, libraryId: unknown, write: boolean) {
  if (typeof libraryId !== 'string' || !isUuid(libraryId)) {
    return { ok: false as const, result: errorResult(NO_SUCH_LIBRARY) };
  }
  const access = await resolveResourceAccess(context.subject, 'prompt_library', libraryId);
  const library = access ? await getLibrary(libraryId) : null;
  if (!access || !library) return { ok: false as const, result: errorResult(NO_SUCH_LIBRARY) };
  if (write && access.role === 'viewer') {
    return {
      ok: false as const,
      result: errorResult(
        `"${library.name}" is shared with this person to view; only its owner and editors can change its prompts. Nothing was changed.`
      ),
    };
  }
  return { ok: true as const, library, role: access.role };
}

async function listLibraries(input: Record<string, unknown>, context: LocalToolContext) {
  if (input.libraryId !== undefined) {
    const opened = await openLibrary(context, input.libraryId, false);
    if (!opened.ok) return opened.result;
    const { library, role } = opened;
    const prompts = await listPrompts(library.id);
    return textResult(
      `${library.name} (library id ${library.id}; ${role}${library.scope === 'code' ? '; code projects only' : ''})` +
        `${library.description ? `\n${library.description}` : ''}\n` +
        `Page: ${markdownLink(context, library.name, libraryPath(library.id))}\n\n` +
        (prompts.length === 0
          ? 'It has no prompts yet.'
          : prompts
              .map((prompt) => `### ${prompt.title}\nprompt id ${prompt.id}\n\n${prompt.body}`)
              .join('\n\n'))
    );
  }
  const libraries = await listAccessibleLibraries(context.subject);
  if (libraries.length === 0) {
    return textResult(
      `This person has no prompt libraries yet. ${CREATE_PROMPT_LIBRARY_TOOL} makes one.`
    );
  }
  const titles = await Promise.all(
    libraries.map(async ({ library }) =>
      (await listPrompts(library.id)).map((prompt) => prompt.title)
    )
  );
  return textResult(
    `${libraries.length} prompt librar${libraries.length === 1 ? 'y' : 'ies'} — call ${LIST_PROMPT_LIBRARIES_TOOL} with libraryId to read one's prompts in full:\n` +
      libraries
        .map(
          ({ library, role }, index) =>
            `- ${library.name} (library id ${library.id}; ${role}${library.scope === 'code' ? '; code projects only' : ''}): ` +
            (titles[index].length === 0 ? 'no prompts yet' : titles[index].join('; '))
        )
        .join('\n')
  );
}

async function createPromptLibrary(input: Record<string, unknown>, context: LocalToolContext) {
  const name = optionalString(input.name, LIBRARY_NAME_MAX_CHARS);
  if (!name) return errorResult('Give the library a name. Nothing was made.');
  const scope = parseLibraryScope(input.scope);
  if (scope === null) return errorResult('scope must be "any" or "code". Nothing was made.');
  const libraryId = await createLibrary({
    ownerSubject: context.subject,
    name,
    description: optionalString(input.description, 2_000) || null,
    ...(scope ? { scope } : {}),
  });
  return textResult(
    `Made the prompt library "${name}" (library id ${libraryId}). It is theirs alone until they share it. ` +
      `${SAVE_PROMPT_TOOL} adds prompts to it. Open it: ${markdownLink(context, name, libraryPath(libraryId))}`
  );
}

async function savePrompt(input: Record<string, unknown>, context: LocalToolContext) {
  const opened = await openLibrary(context, input.libraryId, true);
  if (!opened.ok) return opened.result;
  const { library } = opened;
  const title = optionalString(input.title, PROMPT_TITLE_MAX_CHARS);
  const body =
    typeof input.body === 'string' ? input.body.trim().slice(0, PROMPT_BODY_MAX_CHARS) : undefined;
  const page = markdownLink(context, library.name, libraryPath(library.id));

  if (input.promptId === undefined) {
    if (!title || !body) {
      return errorResult('A new prompt needs a title and a body. Nothing was saved.');
    }
    const promptId = await createPrompt({
      libraryId: library.id,
      title,
      body,
      subject: context.subject,
    });
    return textResult(
      `Saved "${title}" to ${library.name} (prompt id ${promptId}). It is in the composer's prompt picker now. ${page}`
    );
  }

  if (typeof input.promptId !== 'string' || !isUuid(input.promptId)) {
    return errorResult(
      `No such prompt in ${library.name}. Call ${LIST_PROMPT_LIBRARIES_TOOL} with its libraryId for the prompt ids.`
    );
  }
  // An update changes what is sent; a field sent empty is a mistake, not a clearing.
  if (title === '' || body === '') {
    return errorResult("A prompt's title and body cannot be empty. Nothing was changed.");
  }
  const patch: { title?: string; body?: string } = {
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
  };
  if (Object.keys(patch).length === 0) {
    return errorResult('Give the title or the body to change. Nothing was changed.');
  }
  const updated = await updatePrompt(library.id, input.promptId, patch, context.subject);
  if (!updated) {
    return errorResult(
      `No such prompt in ${library.name}. Call ${LIST_PROMPT_LIBRARIES_TOOL} with its libraryId for the prompt ids.`
    );
  }
  return textResult(
    `Updated the prompt's ${Object.keys(patch).join(' and ')} in ${library.name}. ${page}`
  );
}

async function removePrompt(input: Record<string, unknown>, context: LocalToolContext) {
  const opened = await openLibrary(context, input.libraryId, true);
  if (!opened.ok) return opened.result;
  const { library } = opened;
  const missing = errorResult(
    `No such prompt in ${library.name}; nothing was deleted. Call ${LIST_PROMPT_LIBRARIES_TOOL} with its libraryId for the prompt ids.`
  );
  if (typeof input.promptId !== 'string' || !isUuid(input.promptId)) return missing;
  const title = (await listPrompts(library.id)).find(
    (prompt) => prompt.id === input.promptId
  )?.title;
  const deleted = await deletePrompt(library.id, input.promptId);
  if (!deleted) return missing;
  return textResult(
    `Deleted ${title ? `"${title}"` : 'the prompt'} from ${library.name}. It cannot be brought back. ${markdownLink(context, library.name, libraryPath(library.id))}`
  );
}

const LIBRARY_ID = {
  type: 'string',
  description: `The library's id, from ${LIST_PROMPT_LIBRARIES_TOOL}.`,
};

/** All found through find_tools: a chat about anything else carries none of their schemas. */
export function promptLibraryTools(): LocalTool[] {
  return [
    {
      readOnly: true,
      deferred: true,
      def: {
        name: LIST_PROMPT_LIBRARIES_TOOL,
        description:
          "This person's prompt libraries — the reusable prompts the composer's picker offers: every library they own or were given, with its prompts' titles. Give `libraryId` to read one library's prompts in full, with the ids the other prompt tools take.",
        inputSchema: { type: 'object', properties: { libraryId: LIBRARY_ID } },
      },
      execute: listLibraries,
    },
    {
      deferred: true,
      def: {
        name: CREATE_PROMPT_LIBRARY_TOOL,
        description:
          'Make a prompt library for this person: a named collection of reusable prompts, theirs until they share it. Returns its id for renkei_save_prompt, and its link.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'What the library is called.' },
            description: { type: 'string', description: 'A line saying what its prompts are for.' },
            scope: {
              type: 'string',
              enum: ['any', 'code'],
              description:
                '"any" (the default) offers its prompts in every chat; "code" only in code project chats.',
            },
          },
          required: ['name'],
        },
      },
      execute: createPromptLibrary,
    },
    {
      deferred: true,
      def: {
        name: SAVE_PROMPT_TOOL,
        description:
          "Save a prompt in one of this person's prompt libraries. Without `promptId` it adds a new prompt (title and body both needed); with `promptId` it changes that prompt — send only the title or body that changes. Use it when they ask to keep a prompt for reuse, or to reword one. The body is the prompt's text as it will be sent.",
        inputSchema: {
          type: 'object',
          properties: {
            libraryId: LIBRARY_ID,
            promptId: {
              type: 'string',
              description: 'The prompt to change. Leave out to add a new one.',
            },
            title: { type: 'string', description: 'A short name the picker lists it by.' },
            body: { type: 'string', description: "The prompt's text." },
          },
          required: ['libraryId'],
        },
      },
      execute: savePrompt,
    },
    {
      deferred: true,
      def: {
        name: DELETE_PROMPT_TOOL,
        description:
          "Delete one prompt from one of this person's prompt libraries, for good — only when they asked for that prompt to be removed. The library itself stays.",
        inputSchema: {
          type: 'object',
          properties: {
            libraryId: LIBRARY_ID,
            promptId: { type: 'string', description: 'The prompt to delete.' },
          },
          required: ['libraryId', 'promptId'],
        },
      },
      execute: removePrompt,
    },
  ];
}
