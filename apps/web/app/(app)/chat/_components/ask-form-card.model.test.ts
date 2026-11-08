import {
  parseAskFormRequest,
  ASK_FORM_ANSWER_PREFIX,
  type AskFormRequest,
} from '@/lib/chat/ask-form';
import { askFormMode, askFormNote, askFormSubmission, formLaterOf } from './ask-form-card.model';

function request(): AskFormRequest {
  const parsed = parseAskFormRequest({
    intro: 'Before I start.',
    questions: [
      { question: 'Which file?', required: true },
      { question: 'How urgent?', type: 'choice', options: ['low', 'high'] },
      { question: 'How many?', type: 'number', min: 1, max: 5 },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.request;
}

describe('sending the answers', () => {
  it('sends them as a message, each question with its answer', () => {
    const result = askFormSubmission(request(), { q1: 'src/a.ts', q2: 'high', q3: '3' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text.startsWith(ASK_FORM_ANSWER_PREFIX)).toBe(true);
      expect(result.text).toContain('Q: Which file?\nA: src/a.ts');
      expect(result.text).toContain('Q: How urgent?\nA: high');
    }
  });

  it('is refused while a required question has no answer, and says which', () => {
    expect(askFormSubmission(request(), { q2: 'low' })).toEqual({
      ok: false,
      fieldErrors: { q1: 'Needs an answer.' },
    });
  });

  it('is refused for a number out of range, under that question only', () => {
    expect(askFormSubmission(request(), { q1: 'a', q3: '9' })).toEqual({
      ok: false,
      fieldErrors: { q3: 'Must be 5 or less.' },
    });
  });

  it('lets every optional question be skipped', () => {
    expect(askFormSubmission(request(), { q1: 'a' }).ok).toBe(true);
  });

  it('accepts a "Something else" answer to a choice', () => {
    const result = askFormSubmission(request(), { q1: 'a', q2: 'Something else: medium' });
    expect(result.ok && result.text).toContain('A: Something else: medium');
  });
});

describe('who can fill the card in', () => {
  it('the owner, while nothing has come after it', () => {
    expect(askFormMode({ later: 'none', canAnswer: true })).toBe('fill');
    expect(askFormNote('fill')).toBeNull();
  });

  it('nobody once answered, and it points at the message that holds the answers', () => {
    expect(askFormMode({ later: 'answers', canAnswer: true })).toBe('answered');
    expect(askFormNote('answered')).toContain('message below');
  });

  it('nobody once the person said something else instead, and it says so', () => {
    expect(askFormMode({ later: 'other', canAnswer: true })).toBe('closed');
    expect(askFormNote('closed')).toContain('moved on');
  });

  it('someone who cannot send only reads it', () => {
    expect(askFormMode({ later: 'none', canAnswer: false })).toBe('view');
    expect(askFormNote('view')).toContain('owns this chat');
  });
});

describe('what came after the form', () => {
  it('nothing when no turn follows', () => {
    expect(formLaterOf(null)).toBe('none');
  });

  it('the answers when the next turn opens with them', () => {
    expect(formLaterOf([`${ASK_FORM_ANSWER_PREFIX}Q: Which file?\nA: a.ts`])).toBe('answers');
  });

  it('something else when the person wrote their own message instead', () => {
    expect(formLaterOf(['Actually, never mind.'])).toBe('other');
  });
});
