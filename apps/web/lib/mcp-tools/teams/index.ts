/**
 * The Microsoft Teams MCP namespace.
 *
 * A separate capability connector from Outlook, SharePoint and OneDrive
 * even though all four ride the one Microsoft grant: an org admin switching
 * Teams off must not take mail down with it, and "this person has Teams" is
 * a question about the Chat and Channel scopes on their grant, not about a
 * second connection (registry.ts, `teamsAvailable`).
 *
 * Nothing here is indexed. Chats and channel conversations are personal or
 * membership-scoped, so they are read live through the person's own grant
 * — the Outlook rule — and the two tools that write (a chat message, a
 * channel post) speak AS the person, so they run behind a preview card and
 * sit on the agents' always-approve list.
 *
 * How each call authenticates is an injected `GraphAuth` (graph/graph-auth.ts):
 * production passes `oauthGraphAuth`; the "no-sandbox" suite passes
 * `deniedGraphAuth`, since Graph is delegated-OAuth-only with nothing to
 * test against for real yet.
 *
 * Message bodies come back from Graph as HTML (mentions as `<at>`,
 * attachments as placeholders); they are flattened to text here, the same
 * flattening the SharePoint page reader uses. Outgoing text is Markdown,
 * rendered to the same safe HTML subset the Outlook composer sends.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AuthedFetch } from '@renkei/delegate-client';
import { htmlToDocumentText } from '@renkei/document-text';
import type { MCPToolContext } from '../common';
import { withPresentationHint } from '../common';
import { withScopeGate } from '../capability-gate';
import type { GraphAuth } from '../graph/graph-auth';
import type { GraphCallContext } from '../graph/client';
import { graphGet, graphPost, values, str, num, rec, textResult, errText } from '../graph/client';
import { markdownToHtml } from '../outlook/markdown';
import { logger } from '@/lib/logger';
import { teamsScopeFor } from './scopes';

export const TEAMS_MCP_CONNECTOR = 'teams';

/** The most a listing asks Graph for in one page: Teams' own ceiling. */
const PAGE_MAX = 50;

const MARKDOWN_HINT =
  'The message, in Markdown (bold, lists, links, code). Sent as the user; only send what ' +
  'they asked to send. Teams shows it as rich text.';

function when(value: unknown): string {
  const text = str(value);
  return text ? text.replace('T', ' ').slice(0, 16) : '';
}

/** A message body as a person would read it: text, with mentions kept as names. */
function bodyText(body: Record<string, unknown>, maxChars = 2000): string {
  const content = str(body.content);
  if (!content) return '';
  if (str(body.contentType).toLowerCase() === 'html') {
    return htmlToDocumentText(content, maxChars).trim();
  }
  return content.length > maxChars ? `${content.slice(0, maxChars)}…` : content;
}

function senderOf(message: Record<string, unknown>): string {
  const from = rec(message.from);
  return (
    str(rec(from.user).displayName) ||
    str(rec(from.application).displayName) ||
    str(rec(from.device).displayName) ||
    'Unknown sender'
  );
}

function attachmentNames(message: Record<string, unknown>): string[] {
  const attachments = message.attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments
    .map((attachment) => rec(attachment))
    .map((attachment) => str(attachment.name) || str(attachment.contentType))
    .filter(Boolean);
}

/** One message, for a listing: who, when, the text, and the id a reply needs. */
function messageLine(message: Record<string, unknown>, maxChars = 1200): string {
  const text = bodyText(rec(message.body), maxChars) || '(no text)';
  const attachments = attachmentNames(message);
  const edited = str(message.lastEditedDateTime) ? ' (edited)' : '';
  const deleted = str(message.deletedDateTime) ? ' (deleted)' : '';
  return (
    `• ${senderOf(message)} — ${when(message.createdDateTime)}${edited}${deleted}\n` +
    `  ${text.replace(/\n+/g, '\n  ')}\n` +
    (attachments.length > 0 ? `  attachments: ${attachments.join(', ')}\n` : '') +
    `  messageId: ${str(message.id)}`
  );
}

/** Messages a person would read: real posts, not "X joined the chat" events. */
function conversationMessages(body: Record<string, unknown>): Record<string, unknown>[] {
  return values(body).filter((message) => {
    const type = str(message.messageType);
    return type === '' || type === 'message';
  });
}

function memberNames(chat: Record<string, unknown>, selfUpn: string | null): string[] {
  const members = chat.members;
  if (!Array.isArray(members)) return [];
  return members
    .map((member) => rec(member))
    .filter((member) => {
      const address = str(member.email).toLowerCase();
      return !(selfUpn && address && address === selfUpn.toLowerCase());
    })
    .map((member) => str(member.displayName) || str(member.email))
    .filter(Boolean);
}

/** How a chat is named: its topic, else the other people in it. */
function chatTitle(chat: Record<string, unknown>, selfUpn: string | null): string {
  const topic = str(chat.topic);
  if (topic) return topic;
  const names = memberNames(chat, selfUpn);
  if (names.length > 0) return names.join(', ');
  return str(chat.chatType) === 'meeting' ? 'Meeting chat' : 'Chat';
}

function chatLine(chat: Record<string, unknown>, selfUpn: string | null): string {
  const preview = rec(chat.lastMessagePreview);
  const previewBody = rec(preview.body);
  const last = bodyText(previewBody, 160).replace(/\n+/g, ' ');
  const lastFrom = str(rec(rec(preview.from).user).displayName);
  const type = str(chat.chatType);
  return (
    `💬 ${chatTitle(chat, selfUpn)}${type ? ` (${type})` : ''}\n` +
    (last
      ? `    last: ${lastFrom ? `${lastFrom}: ` : ''}${last} — ${when(preview.createdDateTime)}\n`
      : '') +
    `    chatId: ${str(chat.id)}`
  );
}

/** The signed-in user's own object id, for the member list of a new chat. */
async function selfId(
  context: GraphCallContext,
  auth: AuthedFetch
): Promise<{ ok: true; id: string; upn: string } | { ok: false; error: string }> {
  const me = await graphGet(context, auth, '/me?$select=id,userPrincipalName');
  if (!me.ok) return { ok: false, error: me.error };
  const id = str(me.body.id);
  if (!id) return { ok: false, error: 'Graph did not say who the signed-in user is.' };
  return { ok: true, id, upn: str(me.body.userPrincipalName) };
}

/**
 * The 1:1 chat with one colleague, found among the user's chats; created
 * when there is none. Graph has no "chat with this person" lookup, so the
 * 1:1 chats are listed with their members and matched on the address.
 */
async function chatWith(
  context: GraphCallContext,
  auth: AuthedFetch,
  address: string
): Promise<{ ok: true; chatId: string; created: boolean } | { ok: false; error: string }> {
  const wanted = address.trim().toLowerCase();
  const me = await selfId(context, auth);
  if (!me.ok) return me;
  if (me.upn && me.upn.toLowerCase() === wanted) {
    return {
      ok: false,
      error:
        'That address is your own account. Teams has a "chat with yourself" space, but Graph ' +
        'cannot post into it; name a colleague instead.',
    };
  }

  const existing = await graphGet(
    context,
    auth,
    `/me/chats?$filter=chatType eq 'oneOnOne'&$expand=members&$top=${PAGE_MAX}`
  );
  if (!existing.ok) return { ok: false, error: existing.error };
  for (const chat of values(existing.body)) {
    const members = Array.isArray(chat.members) ? chat.members.map((m) => rec(m)) : [];
    if (members.some((member) => str(member.email).toLowerCase() === wanted)) {
      return { ok: true, chatId: str(chat.id), created: false };
    }
  }

  const bind = (who: string) => ({
    '@odata.type': '#microsoft.graph.aadUserConversationMember',
    roles: ['owner'],
    'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${who.replace(/'/g, "''")}')`,
  });
  const created = await graphPost(context, auth, '/chats', {
    chatType: 'oneOnOne',
    members: [bind(me.id), bind(address.trim())],
  });
  if (!created.ok) {
    return {
      ok: false,
      error:
        `${created.error} Starting a new chat needs the Chat.Create scope and a colleague ` +
        `who exists in the directory (${address}).`,
    };
  }
  const chatId = str(created.body.id);
  if (!chatId) return { ok: false, error: 'Graph created the chat but returned no id.' };
  return { ok: true, chatId, created: true };
}

function teamLine(team: Record<string, unknown>): string {
  const description = str(team.description);
  return (
    `👥 ${str(team.displayName)}${str(team.isArchived) === 'true' || team.isArchived === true ? ' (archived)' : ''}\n` +
    (description ? `    ${description.slice(0, 160)}\n` : '') +
    `    teamId: ${str(team.id)}`
  );
}

function channelLine(channel: Record<string, unknown>): string {
  const description = str(channel.description);
  const type = str(channel.membershipType);
  return (
    `# ${str(channel.displayName)}${type && type !== 'standard' ? ` (${type})` : ''}\n` +
    (description ? `    ${description.slice(0, 160)}\n` : '') +
    `    channelId: ${str(channel.id)}`
  );
}

export async function registerTeamsTools(
  rawServer: McpServer,
  context: MCPToolContext,
  auth: GraphAuth
): Promise<void> {
  const server = withScopeGate(rawServer, context.graphScopes, (name) => teamsScopeFor(name));

  // ——— chats ———

  server.registerTool(
    'teams_list_chats',
    {
      title: 'Teams · Read — List my chats',
      description:
        'The user’s Teams chats (1:1, group and meeting chats), most recently active first, each ' +
        'with who is in it, the last message, and the chatId the other chat tools take. Pass ' +
        '`with` to keep only chats whose name or members match a word or an email address.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        with: z
          .string()
          .describe('Keep chats whose topic or members match this name, word or email address.')
          .optional(),
        type: z
          .enum(['oneOnOne', 'group', 'meeting'])
          .describe('Only chats of this kind.')
          .optional(),
        max: z.number().int().min(1).max(PAGE_MAX).describe('How many (default 25).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const type = str(args.type);
      const filter = type ? `&$filter=chatType eq '${type}'` : '';
      const result = await graphGet(
        context,
        access.auth,
        `/me/chats?$expand=members,lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc` +
          `&$top=${PAGE_MAX}${filter}`
      );
      if (!result.ok) return errText(result.error);

      const needle = str(args.with).trim().toLowerCase();
      const max = num(args.max) ?? 25;
      const chats = values(result.body)
        .filter((chat) => {
          if (!needle) return true;
          const haystack = [
            str(chat.topic),
            ...(Array.isArray(chat.members)
              ? chat.members.flatMap((m) => [str(rec(m).displayName), str(rec(m).email)])
              : []),
          ]
            .join(' ')
            .toLowerCase();
          return haystack.includes(needle);
        })
        .slice(0, max);
      if (chats.length === 0) {
        return textResult(needle ? `No chat matches "${str(args.with)}".` : 'No chats yet.');
      }
      return textResult(
        withPresentationHint(
          `${chats.length} chat(s)\n\n${chats.map((chat) => chatLine(chat, access.upn)).join('\n')}`,
          'Render as a list, most recently active first.'
        )
      );
    }
  );

  server.registerTool(
    'teams_list_chat_messages',
    {
      title: 'Teams · Read — Read a chat’s messages',
      description:
        'The latest messages in one chat, newest first — who said what and when, with ' +
        'attachments named. Take the chatId from teams_list_chats. Mentions appear as names; ' +
        'system events (people joining, calls starting) are left out.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        chatId: z.string().min(1).describe('The chat, from teams_list_chats.'),
        max: z.number().int().min(1).max(PAGE_MAX).describe('How many (default 25).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const chatId = str(args.chatId);
      if (!chatId) return errText('chatId is required.');

      const max = num(args.max) ?? 25;
      const result = await graphGet(
        context,
        access.auth,
        `/chats/${encodeURIComponent(chatId)}/messages?$top=${PAGE_MAX}`
      );
      if (!result.ok) return errText(result.error);
      const messages = conversationMessages(result.body).slice(0, max);
      if (messages.length === 0) return textResult('No messages in this chat yet.');
      return textResult(
        withPresentationHint(
          `${messages.length} message(s), newest first\n\n${messages.map((m) => messageLine(m)).join('\n')}`,
          'Render as a conversation, newest first.'
        )
      );
    }
  );

  server.registerTool(
    'teams_search_messages',
    {
      title: 'Teams · Read — Search messages',
      description:
        'Find Teams messages by words — across the user’s chats, and across channels when the ' +
        'grant can read them. Each hit says where it was said and when, with the chat or ' +
        'channel ids to read the rest of the conversation.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().min(1).describe('Words to look for. Teams search syntax applies.'),
        max: z.number().int().min(1).max(PAGE_MAX).describe('How many (default 20).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const query = str(args.query).trim();
      if (!query) return errText('query is required.');

      const max = num(args.max) ?? 20;
      const result = await graphPost(context, access.auth, '/search/query', {
        requests: [
          { entityTypes: ['chatMessage'], query: { queryString: query }, from: 0, size: max },
        ],
      });
      if (!result.ok) return errText(result.error);

      const hits = values(result.body)
        .flatMap((response) =>
          Array.isArray(response.hitsContainers) ? response.hitsContainers.map((c) => rec(c)) : []
        )
        .flatMap((container) =>
          Array.isArray(container.hits) ? container.hits.map((hit) => rec(hit)) : []
        );
      if (hits.length === 0) return textResult(`No Teams message matches "${query}".`);

      const lines = hits.map((hit) => {
        const resource = rec(hit.resource);
        const channel = rec(resource.channelIdentity);
        const where = str(channel.channelId)
          ? `teamId: ${str(channel.teamId)}  channelId: ${str(channel.channelId)}`
          : `chatId: ${str(resource.chatId)}`;
        const summary = str(hit.summary)
          ? htmlToDocumentText(str(hit.summary), 400).replace(/\n+/g, ' ')
          : bodyText(rec(resource.body), 400).replace(/\n+/g, ' ');
        return (
          `• ${senderOf(resource)} — ${when(resource.createdDateTime)}\n` +
          `  ${summary || '(no text)'}\n` +
          `  ${where}  messageId: ${str(resource.id)}`
        );
      });
      return textResult(
        withPresentationHint(
          `${hits.length} message(s) matching "${query}"\n\n${lines.join('\n')}`,
          'Render as a list of search hits.'
        )
      );
    }
  );

  server.registerTool(
    'teams_send_chat_message',
    {
      title: 'Teams · Act — Send a chat message',
      description:
        'Post a message in a Teams chat as the user — into an existing chat by chatId, or to ' +
        'one colleague by email address (their 1:1 chat is found, or started if there is none). ' +
        'This speaks AS the user, so only send what they asked to send. Markdown supported.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        chatId: z.string().describe('An existing chat, from teams_list_chats.').optional(),
        toEmail: z
          .string()
          .describe('A colleague’s email address, for a 1:1 chat instead of a chatId.')
          .optional(),
        markdown: z.string().min(1).describe(MARKDOWN_HINT),
      }),
    },
    async (args: Record<string, unknown>) => {
      const chatId = str(args.chatId);
      const toEmail = str(args.toEmail).trim();
      if (!chatId && !toEmail) return errText('Provide chatId or toEmail.');
      if (chatId && toEmail) return errText('Provide chatId or toEmail, not both.');
      const markdown = str(args.markdown);
      if (!markdown.trim()) return errText('markdown is required.');

      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      let target = chatId;
      let started = false;
      if (!target) {
        const found = await chatWith(context, access.auth, toEmail);
        if (!found.ok) return errText(found.error);
        target = found.chatId;
        started = found.created;
      }

      const sent = await graphPost(
        context,
        access.auth,
        `/chats/${encodeURIComponent(target)}/messages`,
        {
          body: { contentType: 'html', content: markdownToHtml(markdown) },
        }
      );
      if (!sent.ok) return errText(sent.error);
      logger.info('teams_send_chat_message sent', {
        component: 'mcp/tool',
        subject: context.subject,
        chatId: target,
        started,
      });
      return textResult(
        `Sent (message id ${str(sent.body.id) || 'unknown'}, chat ${target}` +
          `${started ? ', new chat' : ''}).`
      );
    }
  );

  // ——— teams and channels ———

  server.registerTool(
    'teams_list_teams',
    {
      title: 'Teams · Read — List my teams',
      description: 'The teams the user belongs to, with the teamId the channel tools take.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        max: z.number().int().min(1).max(100).describe('How many (default 50).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const result = await graphGet(context, access.auth, '/me/joinedTeams');
      if (!result.ok) return errText(result.error);
      const max = num(args.max) ?? 50;
      const teams = values(result.body)
        .sort((a, b) => str(a.displayName).localeCompare(str(b.displayName)))
        .slice(0, max);
      if (teams.length === 0) return textResult('You are not a member of any team.');
      return textResult(
        withPresentationHint(
          `${teams.length} team(s)\n\n${teams.map(teamLine).join('\n')}`,
          'Render as a list of teams.'
        )
      );
    }
  );

  server.registerTool(
    'teams_list_channels',
    {
      title: 'Teams · Read — List a team’s channels',
      description:
        'The channels of one team the user can see, with the channelId the message tools take. ' +
        'Private and shared channels appear only when the user is in them.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        teamId: z.string().min(1).describe('The team, from teams_list_teams.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const teamId = str(args.teamId);
      if (!teamId) return errText('teamId is required.');

      const result = await graphGet(
        context,
        access.auth,
        `/teams/${encodeURIComponent(teamId)}/channels`
      );
      if (!result.ok) return errText(result.error);
      const channels = values(result.body);
      if (channels.length === 0) return textResult('This team has no channels you can see.');
      return textResult(
        withPresentationHint(
          `${channels.length} channel(s)\n\n${channels.map(channelLine).join('\n')}`,
          'Render as a list of channels.'
        )
      );
    }
  );

  server.registerTool(
    'teams_list_channel_messages',
    {
      title: 'Teams · Read — Read a channel’s posts',
      description:
        'The latest top-level posts in a channel, newest first. Replies are not included — pass ' +
        'a post’s messageId to teams_list_replies to read its thread.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        teamId: z.string().min(1).describe('The team, from teams_list_teams.'),
        channelId: z.string().min(1).describe('The channel, from teams_list_channels.'),
        max: z.number().int().min(1).max(PAGE_MAX).describe('How many (default 25).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const teamId = str(args.teamId);
      const channelId = str(args.channelId);
      if (!teamId || !channelId) return errText('teamId and channelId are required.');

      const max = num(args.max) ?? 25;
      const result = await graphGet(
        context,
        access.auth,
        `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=${PAGE_MAX}`
      );
      if (!result.ok) return errText(result.error);
      const posts = conversationMessages(result.body).slice(0, max);
      if (posts.length === 0) return textResult('No posts in this channel yet.');
      const lines = posts.map((post) => {
        const subject = str(post.subject);
        return (subject ? `**${subject}**\n` : '') + messageLine(post);
      });
      return textResult(
        withPresentationHint(
          `${posts.length} post(s), newest first\n\n${lines.join('\n')}`,
          'Render as a list of posts, newest first.'
        )
      );
    }
  );

  server.registerTool(
    'teams_list_replies',
    {
      title: 'Teams · Read — Read a post’s replies',
      description: 'The replies under one channel post, newest first.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        teamId: z.string().min(1).describe('The team.'),
        channelId: z.string().min(1).describe('The channel.'),
        messageId: z.string().min(1).describe('The post, from teams_list_channel_messages.'),
        max: z.number().int().min(1).max(PAGE_MAX).describe('How many (default 25).').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const teamId = str(args.teamId);
      const channelId = str(args.channelId);
      const messageId = str(args.messageId);
      if (!teamId || !channelId || !messageId) {
        return errText('teamId, channelId and messageId are required.');
      }

      const max = num(args.max) ?? 25;
      const result = await graphGet(
        context,
        access.auth,
        `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}` +
          `/messages/${encodeURIComponent(messageId)}/replies?$top=${PAGE_MAX}`
      );
      if (!result.ok) return errText(result.error);
      const replies = conversationMessages(result.body).slice(0, max);
      if (replies.length === 0) return textResult('No replies to this post yet.');
      return textResult(
        withPresentationHint(
          `${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}, newest first\n\n` +
            replies.map((reply) => messageLine(reply)).join('\n'),
          'Render as a thread, newest first.'
        )
      );
    }
  );

  server.registerTool(
    'teams_send_channel_message',
    {
      title: 'Teams · Act — Post in a channel',
      description:
        'Post in a Teams channel as the user: a new post (optionally with a subject line), or a ' +
        'reply under an existing post when replyToId is given. This speaks AS the user and is ' +
        'seen by everyone in the channel, so only post what they asked to post. Markdown supported.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        teamId: z.string().min(1).describe('The team, from teams_list_teams.'),
        channelId: z.string().min(1).describe('The channel, from teams_list_channels.'),
        markdown: z.string().min(1).describe(MARKDOWN_HINT),
        subject: z.string().describe('A subject line for a new post (not for a reply).').optional(),
        replyToId: z
          .string()
          .describe('Reply under this post (its messageId) instead of starting a new one.')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const teamId = str(args.teamId);
      const channelId = str(args.channelId);
      const markdown = str(args.markdown);
      if (!teamId || !channelId) return errText('teamId and channelId are required.');
      if (!markdown.trim()) return errText('markdown is required.');
      const replyToId = str(args.replyToId);
      const subject = str(args.subject).trim();

      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const base = `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`;
      const path = replyToId ? `${base}/${encodeURIComponent(replyToId)}/replies` : base;
      const sent = await graphPost(context, access.auth, path, {
        ...(subject && !replyToId ? { subject } : {}),
        body: { contentType: 'html', content: markdownToHtml(markdown) },
      });
      if (!sent.ok) return errText(sent.error);
      logger.info('teams_send_channel_message posted', {
        component: 'mcp/tool',
        subject: context.subject,
        teamId,
        channelId,
        reply: Boolean(replyToId),
      });
      const url = str(sent.body.webUrl);
      return textResult(
        `${replyToId ? 'Replied' : 'Posted'} (message id ${str(sent.body.id) || 'unknown'}).` +
          (url ? `\n${url}` : '')
      );
    }
  );

  // ——— presence ———

  server.registerTool(
    'teams_get_presence',
    {
      title: 'Teams · Read — Who is available right now',
      description:
        'Whether people are available, busy, in a meeting, away or offline in Teams right now, ' +
        'and their status message if they set one. Name colleagues by email address; leave the ' +
        'list empty for the user’s own presence.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        emails: z
          .array(z.string().min(1))
          .max(20)
          .describe('Colleagues’ email addresses (up to 20). Empty = the user themself.')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const emails = Array.isArray(args.emails)
        ? args.emails.filter((e): e is string => typeof e === 'string' && e.trim() !== '')
        : [];

      if (emails.length === 0) {
        const mine = await graphGet(context, access.auth, '/me/presence');
        if (!mine.ok) return errText(mine.error);
        return textResult(presenceLine('You', mine.body));
      }

      // Presence is looked up by object id, so each address is resolved
      // first; one person who cannot be found does not sink the rest.
      const people: { name: string; id: string }[] = [];
      const missing: string[] = [];
      for (const email of emails.slice(0, 20)) {
        const user = await graphGet(
          context,
          access.auth,
          `/users/${encodeURIComponent(email.trim())}?$select=id,displayName`
        );
        if (!user.ok || !str(user.body.id)) {
          missing.push(email);
          continue;
        }
        people.push({ name: str(user.body.displayName) || email, id: str(user.body.id) });
      }
      if (people.length === 0) {
        return errText(`Nobody in the directory matched: ${missing.join(', ')}.`);
      }

      const presences = await graphPost(
        context,
        access.auth,
        '/communications/getPresencesByUserId',
        {
          ids: people.map((person) => person.id),
        }
      );
      if (!presences.ok) return errText(presences.error);
      const byId = new Map(values(presences.body).map((presence) => [str(presence.id), presence]));
      const lines = people.map((person) => presenceLine(person.name, byId.get(person.id) ?? {}));
      if (missing.length > 0) lines.push(`Not found in the directory: ${missing.join(', ')}`);
      return textResult(
        withPresentationHint(lines.join('\n'), 'Render as a short list, one person per line.')
      );
    }
  );
}

function presenceLine(name: string, presence: Record<string, unknown>): string {
  const availability = str(presence.availability) || 'Unknown';
  const activity = str(presence.activity);
  const status = str(rec(rec(presence.statusMessage).message).content);
  return (
    `• ${name}: ${availability}` +
    (activity && activity !== availability ? ` (${activity})` : '') +
    (status ? ` — “${status.slice(0, 160)}”` : '')
  );
}
