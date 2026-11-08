import {
  ASK_FORM_ANSWER_PREFIX,
  askFormAnswersText,
  parseAskFormRequest,
  type AskFormRequest,
} from '@/lib/chat/ask-form';
import {
  askFormMode,
  askFormNote,
  askFormSubmission,
  askFormSummary,
  formLaterOf,
} from './ask-form-card.model';

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

const ANSWERS = {
  rows: [
    { question: 'Which file should I review?', answer: 'src/billing.ts' },
    { question: 'What should I focus on?', answer: null },
  ],
  also: null,
};

describe('who can fill the card in', () => {
  it('the owner, while nothing has come after it', () => {
    expect(askFormMode({ later: { kind: 'none' }, canAnswer: true })).toBe('fill');
    expect(askFormNote('fill')).toBeNull();
  });

  it('nobody once answered: the card is then a collapsed record', () => {
    expect(askFormMode({ later: { kind: 'answers', answers: ANSWERS }, canAnswer: true })).toBe(
      'answered'
    );
    expect(askFormNote('answered')).toBeNull();
  });

  it('nobody once the person said something else instead, and it says so', () => {
    expect(askFormMode({ later: { kind: 'other' }, canAnswer: true })).toBe('closed');
    expect(askFormNote('closed')).toContain('moved on');
  });

  it('someone who cannot send only reads it', () => {
    expect(askFormMode({ later: { kind: 'none' }, canAnswer: false })).toBe('view');
    expect(askFormNote('view')).toContain('owns this chat');
  });
});

describe('what came after the form', () => {
  const sent = askFormAnswersText(request(), { q1: 'src/a.ts', q2: 'high' });

  it('nothing when no turn follows', () => {
    expect(formLaterOf(null)).toEqual({ kind: 'none' });
  });

  it('the answers, read back, when the next turn opens with them', () => {
    const later = formLaterOf([sent]);
    expect(later.kind).toBe('answers');
    expect(later.kind === 'answers' && later.answers.rows[0]).toEqual({
      question: 'Which file?',
      answer: 'src/a.ts',
    });
  });

  it('something else when the person wrote their own message instead', () => {
    expect(formLaterOf(['Actually, never mind.'])).toEqual({ kind: 'other' });
  });
});

describe('the collapsed card’s line', () => {
  it('says how many questions were answered of how many', () => {
    expect(askFormSummary(ANSWERS)).toBe('Answered 1 of 2 questions');
  });

  it('is singular for one question', () => {
    expect(askFormSummary({ rows: [ANSWERS.rows[0]], also: null })).toBe(
      'Answered 1 of 1 question'
    );
  });

  it('just says answered when there were no questions to count', () => {
    expect(askFormSummary({ rows: [], also: 'Be brief.' })).toBe('Answered');
  });
});
