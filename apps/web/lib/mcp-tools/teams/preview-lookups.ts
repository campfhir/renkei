/**
 * The names behind the ids a Teams act's preview card carries (see
 * ../lookup.ts): the chat (its topic, else who is in it), the team, the
 * channel, and the post being replied to. Reads only; a failure leaves the
 * name out and the card says "a Teams chat".
 */

import type { MCPToolContext } from '../common';
import type { GraphAuth } from '../graph/graph-auth';
import { enc, withReader } from '../graph/preview-lookups';
import { registerPreviewLookups } from '../lookup';
import { nameKey, record, records, text } from '../previews/card';

const EXCERPT = 80;

/** A message body as one short line of text. */
function excerptOf(body: unknown): string {
  const value = record(body);
  const raw = text(value.content);
  const plain = (text(value.contentType) === 'html' ? raw.replace(/<[^>]*>/g, ' ') : raw)
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > EXCERPT ? `${plain.slice(0, EXCERPT)}…` : plain;
}

export function registerTeamsPreviewLookups(context: MCPToolContext, auth: GraphAuth): void {
  registerPreviewLookups(context, {
    teams_send_chat_message: withReader(context, auth, async (read, args) => {
      const chatId = text(args.chatId);
      if (!chatId) return {};
      const [chat, upn] = await Promise.all([
        read.get(`/chats/${enc(chatId)}?$expand=members`),
        read.upn(),
      ]);
      if (!chat) return {};
      const others = records(chat.members)
        .filter((member) => !(upn && text(member.email).toLowerCase() === upn.toLowerCase()))
        .map((member) => text(member.displayName) || text(member.email))
        .filter(Boolean);
      const title = text(chat.topic) || others.join(', ');
      return title ? { [nameKey('chat', chatId)]: title } : {};
    }),

    teams_send_channel_message: withReader(context, auth, async (read, args) => {
      const teamId = text(args.teamId);
      const channelId = text(args.channelId);
      const replyToId = text(args.replyToId);
      const [team, channel, post] = await Promise.all([
        teamId ? read.get(`/teams/${enc(teamId)}?$select=displayName`) : Promise.resolve(null),
        teamId && channelId
          ? read.get(`/teams/${enc(teamId)}/channels/${enc(channelId)}?$select=displayName`)
          : Promise.resolve(null),
        teamId && channelId && replyToId
          ? read.get(`/teams/${enc(teamId)}/channels/${enc(channelId)}/messages/${enc(replyToId)}`)
          : Promise.resolve(null),
      ]);
      const names: Record<string, string> = {};
      if (text(team?.displayName)) names[nameKey('team', teamId)] = text(team?.displayName);
      if (text(channel?.displayName)) {
        names[nameKey('channel', channelId)] = text(channel?.displayName);
      }
      if (post) {
        const author = text(record(record(post.from).user).displayName);
        const excerpt = excerptOf(post.body);
        const label = [author ? `by ${author}` : '', excerpt ? `“${excerpt}”` : '']
          .filter(Boolean)
          .join(': ');
        if (label) names[nameKey('post', replyToId)] = label;
      }
      return names;
    }),
  });
}
