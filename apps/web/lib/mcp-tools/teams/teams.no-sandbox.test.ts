/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Teams, with no sandbox to test against. Mirrors
 * onedrive/onedrive.no-sandbox.test.ts — see that file, and webex/zoom's
 * equivalents, for the full reasoning: every tool must fail cleanly on a
 * denied credential, and the list here is the registered surface.
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
import { registerTeamsTools } from './index';
import { teamsScopeFor } from './scopes';
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
  await registerTeamsTools(server, context(), deniedGraphAuth());
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

const TOOLS = [
  'teams_list_chats',
  'teams_list_chat_messages',
  'teams_search_messages',
  'teams_send_chat_message',
  'teams_list_teams',
  'teams_list_channels',
  'teams_list_channel_messages',
  'teams_list_replies',
  'teams_send_channel_message',
  'teams_get_presence',
];

/** Arguments that pass each tool's own validation, so the credential is what fails. */
const ARGS: Record<string, Record<string, unknown>> = {
  teams_list_chat_messages: { chatId: 'chat-1' },
  teams_search_messages: { query: 'budget' },
  teams_send_chat_message: { chatId: 'chat-1', markdown: 'hello' },
  teams_list_channels: { teamId: 'team-1' },
  teams_list_channel_messages: { teamId: 'team-1', channelId: 'channel-1' },
  teams_list_replies: { teamId: 'team-1', channelId: 'channel-1', messageId: 'm-1' },
  teams_send_channel_message: { teamId: 'team-1', channelId: 'channel-1', markdown: 'hello' },
};

describe('every Teams tool, against a denied credential', () => {
  it('covers every tool registerTeamsTools actually registers', async () => {
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
    const result = await (await tools()).get('teams_list_chats')!({});

    expect(textOf(result)).toContain('No Microsoft test credential is configured');
  });

  it('gates every write tool on a send scope, never the chat-read default', async () => {
    // withScopeGate falls back to the `default:` branch for a name missing
    // from the switch — a write that fell there would register for anyone
    // who can merely read chats.
    for (const tool of TOOLS.filter((name) => name.includes('_send_'))) {
      expect(teamsScopeFor(tool).every((scope) => /Send$/.test(scope))).toBe(true);
    }
    expect(teamsScopeFor('teams_list_channel_messages')).toEqual(['ChannelMessage.Read.All']);
    expect(teamsScopeFor('teams_get_presence')).toEqual(['Presence.Read.All']);
  });
});
