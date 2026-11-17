import { chatAskHeadline } from './chat-ask-notification';

describe('what the person who asked an agent from a chat is told', () => {
  it('that it replied, in that chat, however it ended short of failing', () => {
    expect(chatAskHeadline('Triage', 'Who owns INC-42?', 'succeeded')).toBe(
      'Triage replied in “Who owns INC-42?”'
    );
    expect(chatAskHeadline('Triage', 'New chat', 'stopped')).toBe('Triage replied in “New chat”');
  });

  it('that it could not finish, when the run failed', () => {
    expect(chatAskHeadline('Triage', 'Q3 close', 'failed')).toBe(
      'Triage could not finish what you asked in “Q3 close”'
    );
  });
});
