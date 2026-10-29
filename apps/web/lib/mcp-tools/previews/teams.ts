/**
 * Preview cards for Teams: the two tools that speak as the person, a chat
 * message and a channel post. Both are a comment card — words landing in a
 * conversation — with the words editable before they go.
 */

import type { PreviewBuilder } from './card';
import { ref, text } from './card';

const TEAMS = 'Teams';

export const TEAMS_PREVIEWS: Record<string, PreviewBuilder> = {
  teams_send_chat_message: (args) => {
    const toEmail = text(args.toEmail);
    const chatId = text(args.chatId);
    const destination = toEmail || `chat ${chatId}`;
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
        on: ref(toEmail ? toEmail : 'Chat', toEmail ? '1:1 chat' : chatId, 'Sent as you, in Teams'),
        bodyKey: 'markdown',
        body: text(args.markdown),
        badges: toEmail ? ['1:1 chat (started if there is none)'] : ['Existing chat'],
      },
    };
  },

  teams_send_channel_message: (args) => {
    const replyTo = text(args.replyToId);
    const subject = text(args.subject);
    return {
      verb: replyTo ? 'Reply' : 'Post',
      icon: 'comment',
      title: replyTo
        ? `Reply in a Teams channel`
        : subject
          ? `Post “${subject}” in a Teams channel`
          : 'Post in a Teams channel',
      subtitle: TEAMS,
      confirmLabel: replyTo ? 'Post reply' : 'Post',
      editable: [{ key: 'markdown', label: replyTo ? 'Reply' : 'Post', multiline: true }],
      body: {
        kind: 'comment',
        mode: 'add',
        on: ref(
          `Channel ${text(args.channelId)}`,
          subject || undefined,
          `Team ${text(args.teamId)} — everyone in the channel sees it`
        ),
        bodyKey: 'markdown',
        body: text(args.markdown),
        badges: replyTo ? [`Reply to post ${replyTo}`] : ['New post'],
      },
    };
  },
};
