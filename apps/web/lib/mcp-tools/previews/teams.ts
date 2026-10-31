/**
 * Preview cards for Teams: the two tools that speak as the person, a chat
 * message and a channel post. Both are a comment card — words landing in a
 * conversation — with the words editable before they go.
 */

import type { PreviewBuilder } from './card';
import { named, ref, text } from './card';

const TEAMS = 'Teams';

export const TEAMS_PREVIEWS: Record<string, PreviewBuilder> = {
  teams_send_chat_message: (args, names) => {
    const toEmail = text(args.toEmail);
    const chat = named(names, 'chat', args.chatId);
    const destination = toEmail || (chat ? `chat with ${chat}` : 'a Teams chat');
    return {
      verb: 'Send',
      icon: 'comment',
      title: `Send a Teams message to ${destination}`,
      subtitle: TEAMS,
      confirmLabel: 'Send message',
      editable: [{ key: 'markdown', label: 'Message', multiline: true }],
      body: {
        kind: 'comment',
        mode: 'add',
        on: ref(
          toEmail || chat || 'Chat',
          toEmail ? '1:1 chat' : 'Existing chat',
          'Sent as you, in Teams'
        ),
        bodyKey: 'markdown',
        body: text(args.markdown),
        badges: toEmail ? ['1:1 chat (started if there is none)'] : ['Existing chat'],
      },
    };
  },

  teams_send_channel_message: (args, names) => {
    const replyTo = text(args.replyToId);
    const subject = text(args.subject);
    const channel = named(names, 'channel', args.channelId);
    const team = named(names, 'team', args.teamId);
    const post = named(names, 'post', args.replyToId);
    return {
      verb: replyTo ? 'Reply' : 'Post',
      icon: 'comment',
      title: replyTo
        ? `Reply in ${channel || 'a Teams channel'}`
        : subject
          ? `Post “${subject}” in ${channel || 'a Teams channel'}`
          : `Post in ${channel || 'a Teams channel'}`,
      subtitle: TEAMS,
      confirmLabel: replyTo ? 'Post reply' : 'Post',
      editable: [{ key: 'markdown', label: replyTo ? 'Reply' : 'Post', multiline: true }],
      body: {
        kind: 'comment',
        mode: 'add',
        on: ref(
          channel ? `Channel ${channel}` : 'The channel',
          subject || undefined,
          `${team ? `Team ${team} — ` : ''}everyone in the channel sees it`
        ),
        bodyKey: 'markdown',
        body: text(args.markdown),
        badges: replyTo ? [post ? `Reply to a post ${post}` : 'Reply to a post'] : ['New post'],
      },
    };
  },
};
