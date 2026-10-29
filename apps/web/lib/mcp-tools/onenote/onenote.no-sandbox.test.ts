/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * OneNote, with no sandbox to test against. Mirrors
 * onedrive/onedrive.no-sandbox.test.ts — see that file for the reasoning:
 * every tool must fail cleanly on a denied credential, and the list here
 * is the registered surface.
 */

jest.mock('@renkei/db', () => ({
  getDataStore: () =>
    new Proxy(
      {},
      {
        get: () =>
          new Proxy(
            {},
            {
              get: () => async () => {
                throw new Error('no data store in this suite');
              },
            }
          ),
      }
    ),
}));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerOneNoteTools } from './index';
import { onenoteScopeFor } from './scopes';
import { deniedGraphAuth } from '../graph/graph-auth';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

const context = (): MCPToolContext => ({ subject: 'subject-1' }) as unknown as MCPToolContext;

async function tools(): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerOneNoteTools(server, context(), deniedGraphAuth());
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

const TOOLS = [
  'onenote_list_notebooks',
  'onenote_list_sections',
  'onenote_list_pages',
  'onenote_read_page',
  'onenote_create_section',
  'onenote_create_page',
  'onenote_append_to_page',
  'onenote_delete_page',
];

/** Arguments that pass each tool's own validation, so the credential is what fails. */
const ARGS: Record<string, Record<string, unknown>> = {
  onenote_read_page: { pageId: 'page-1' },
  onenote_create_section: { notebookId: 'nb-1', name: 'Meetings' },
  onenote_create_page: { sectionId: 'sec-1', title: 'Notes' },
  onenote_append_to_page: { pageId: 'page-1', markdown: 'more' },
  onenote_delete_page: { pageId: 'page-1' },
};

describe('every OneNote tool, against a denied credential', () => {
  it('covers every tool registerOneNoteTools actually registers', async () => {
    const registered = [...(await tools()).keys()].sort();
    expect([...TOOLS].sort()).toEqual(registered);
  });

  it.each(TOOLS)('%s fails cleanly, not by throwing', async (tool) => {
    const handler = (await tools()).get(tool)!;

    const result = await handler(ARGS[tool] ?? {});

    expect(result.isError).toBe(true);
    expect(textOf(result).length).toBeGreaterThan(0);
    expect(textOf(result)).not.toContain('undefined');
    expect(textOf(result)).not.toContain('[object Object]');
  });

  it('names the actual reason, not a bare status code', async () => {
    const result = await (await tools()).get('onenote_list_notebooks')!({});

    expect(textOf(result)).toContain('No Microsoft test credential is configured');
  });

  it('gates every write tool explicitly on Notes.ReadWrite', async () => {
    // A write missing from the switch would fall to the read default and
    // register for anyone who can merely read notebooks.
    const writes = TOOLS.filter((name) => /_(create|append|delete)_/.test(name));
    expect(writes.length).toBe(4);
    for (const name of writes) expect(onenoteScopeFor(name)).toEqual(['Notes.ReadWrite']);
    expect(onenoteScopeFor('onenote_read_page')).toEqual(['Notes.Read']);
  });
});
