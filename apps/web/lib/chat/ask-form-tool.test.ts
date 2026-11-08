import { ASK_FORM_TOOL } from './ask-form';
import { askFormTools } from './ask-form-tool';
import { endsTurn, type LocalToolContext } from './local-tools';
import { resourceCipher } from './content-crypto';

const [tool] = askFormTools();
const context: LocalToolContext = {
  subject: 'u1',
  chatId: 'c1',
  cipher: resourceCipher({ id: '00000000-0000-4000-8000-00000000c1fe', key: Buffer.alloc(32, 7) }),
  projectId: null,
  readOnly: false,
};

describe('chat_ask_form', () => {
  it('is one read-only tool of that name', () => {
    expect(askFormTools()).toHaveLength(1);
    expect(tool?.def.name).toBe(ASK_FORM_TOOL);
    expect(tool?.readOnly).toBe(true);
  });

  it('ends the turn and says the answers will arrive as the next message', async () => {
    const result = await tool?.execute(
      { questions: [{ question: 'Which file?' }, { question: 'Why?' }] },
      context
    );
    expect(result && endsTurn(result)).toBe(true);
    expect(result?.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(result?.content)).toContain('2 questions');
    expect(JSON.stringify(result?.content)).toContain('next message');
  });

  it('says "a question" for one', async () => {
    const result = await tool?.execute({ questions: [{ question: 'Which file?' }] }, context);
    expect(JSON.stringify(result?.content)).toContain('a question');
  });

  it('refuses a malformed call with the reason, and does not end the turn', async () => {
    const result = await tool?.execute({ questions: [] }, context);
    expect(result?.isError).toBe(true);
    expect(result && endsTurn(result)).toBe(false);
  });
});
