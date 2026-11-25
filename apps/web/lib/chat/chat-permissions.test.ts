import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import {
  NO_CHAT_TOOL_ANSWERS,
  parseChatToolAnswers,
  rememberChatToolAnswer,
  withChatToolAnswer,
} from './chat-permissions';

describe('a chat’s own tool answers', () => {
  it('reads what was stored; a name on both lists is blocked', () => {
    expect(parseChatToolAnswers(null)).toEqual(NO_CHAT_TOOL_ANSWERS);
    expect(parseChatToolAnswers({ allow: ['b', 'a', 'x y'], deny: ['b'] })).toEqual({
      allow: ['a'],
      deny: ['b'],
    });
  });

  it('blocking a tool allowed in this chat moves it, and back', () => {
    const allowed = withChatToolAnswer(NO_CHAT_TOOL_ANSWERS, 'jira_create_issue', 'allow');
    const blocked = withChatToolAnswer(allowed, 'jira_create_issue', 'deny');
    expect(blocked).toEqual({ allow: [], deny: ['jira_create_issue'] });
    expect(withChatToolAnswer(blocked, 'jira_create_issue', 'allow')).toEqual(allowed);
  });

  it('"ask" takes a decision back, whichever list it was on', () => {
    const both = { allow: ['jira_create_issue'], deny: ['outlook_send_mail'] };
    expect(withChatToolAnswer(both, 'outlook_send_mail', 'ask')).toEqual({
      allow: ['jira_create_issue'],
      deny: [],
    });
    expect(withChatToolAnswer(both, 'jira_create_issue', 'ask')).toEqual({
      allow: [],
      deny: ['outlook_send_mail'],
    });
  });

  it('is kept on that chat alone', async () => {
    registerDataStore(createMemoryDataStore());
    try {
      const make = () =>
        getDataStore().chats.create({
          ownerSubject: 'ann',
          projectId: null,
          llmModelId: null,
          toolConfig: null,
          thinkingEnabled: false,
          autoMode: false,
        });
      const [one, two] = [await make(), await make()];
      expect(await rememberChatToolAnswer(one, 'jira_create_issue', 'allow')).not.toBeNull();
      expect(await rememberChatToolAnswer(one, 'outlook_send_mail', 'deny')).toEqual({
        allow: ['jira_create_issue'],
        deny: ['outlook_send_mail'],
      });
      expect(parseChatToolAnswers((await getDataStore().chats.get(one))?.toolPermissions)).toEqual({
        allow: ['jira_create_issue'],
        deny: ['outlook_send_mail'],
      });
      expect((await getDataStore().chats.get(two))?.toolPermissions).toBeNull();
      expect(await rememberChatToolAnswer(one, 'not a tool', 'allow')).toBeNull();
      // Taking both back leaves the chat with nothing stored.
      await rememberChatToolAnswer(one, 'jira_create_issue', 'ask');
      await rememberChatToolAnswer(one, 'outlook_send_mail', 'ask');
      expect((await getDataStore().chats.get(one))?.toolPermissions).toBeNull();
    } finally {
      resetDataStore();
    }
  });
});
