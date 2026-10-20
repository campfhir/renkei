import {
  ANYTHING_ELSE_FIELD,
  REPLY_FIELD,
  answersForAgent,
  askedQuestionsOf,
} from './ask-questions';
import { flattenFormFields } from './question-form';

describe('askedQuestionsOf', () => {
  it('gives a conversational question one reply box', () => {
    const asked = askedQuestionsOf({
      intro: 'Which issue should the go-live status go on, and why?',
    });
    if (!asked.ok) throw new Error(asked.error);
    expect(asked.message).toBe('Which issue should the go-live status go on, and why?');
    expect(flattenFormFields(asked.form)).toEqual([
      expect.objectContaining({
        name: REPLY_FIELD,
        label: 'Your reply',
        type: 'longtext',
        required: false,
      }),
    ]);
  });

  it('turns a batch into one optional field per question, with its evidence, and an anything-else box', () => {
    const asked = askedQuestionsOf({
      intro: 'ATLAS went live; two things need a home.',
      questions: [
        {
          question: 'Should the go-live status go on CIO-5, CIO-25 or CIO-26?',
          context: '837 lab orders on 10/19.',
          // A catch-all the model listed folds into the card's own.
          answer: { type: 'choice', options: ['CIO-5', 'CIO-25', 'CIO-26', 'CIO-25', 'Other'] },
        },
        { question: 'Does the SFTP work need a CIO-39 update?', answer: { type: 'yesno' } },
        { question: 'What else is still open?' },
        {
          question: 'How many results came in?',
          answer: { type: 'number', min: 0, hint: 'per day' },
        },
      ],
      timeoutHours: 12,
    });
    if (!asked.ok) throw new Error(asked.error);
    expect(asked.timeoutHours).toBe(12);
    const fields = flattenFormFields(asked.form);
    expect(fields.map((field) => [field.name, field.type, field.required])).toEqual([
      ['q1', 'choice', false],
      ['q2', 'choice', false],
      ['q3', 'longtext', false],
      ['q4', 'number', false],
      [ANYTHING_ELSE_FIELD, 'longtext', false],
    ]);
    expect(fields[0]).toMatchObject({
      label: 'Should the go-live status go on CIO-5, CIO-25 or CIO-26?',
      context: '837 lab orders on 10/19.',
      options: ['CIO-5', 'CIO-25', 'CIO-26'],
      other: 'Something else',
    });
    // Yes/no is a closed question: no "something else".
    expect(fields[1].options).toEqual(['Yes', 'No']);
    expect(fields[1].other).toBeUndefined();
    expect(fields[3]).toMatchObject({ min: 0, help: 'per day' });
  });

  it('reads the older {message, form}, and gives a form with nothing to answer a reply box', () => {
    const legacy = askedQuestionsOf({
      message: 'Which project?',
      form: [{ kind: 'field', name: 'project', label: 'Project', type: 'text', required: true }],
    });
    expect(legacy.ok && flattenFormFields(legacy.form).map((field) => field.name)).toEqual([
      'project',
    ]);
    const bare = askedQuestionsOf({
      message: 'Here is what I found.',
      form: [{ kind: 'paragraph', text: 'Context' }],
    });
    expect(bare.ok && flattenFormFields(bare.form).map((field) => field.name)).toEqual([
      REPLY_FIELD,
    ]);
  });

  it('says what is wrong with a malformed call', () => {
    const cases: [unknown, string][] = [
      [{}, 'needs an intro'],
      [{ intro: 'x', questions: [{}] }, 'Question 1: write the question'],
      [
        { intro: 'x', questions: [{ question: 'Q?', answer: { type: 'choice', options: ['a'] } }] },
        'at least two options',
      ],
      [
        { intro: 'x', questions: [{ question: 'Q?', answer: { type: 'slider' } }] },
        'answer.type is one of',
      ],
      [{ intro: 'x', questions: [{ question: 'Q?'.repeat(200) }] }, 'one sentence'],
      [
        { intro: 'x', questions: Array.from({ length: 11 }, () => ({ question: 'Q?' })) },
        'at most 10',
      ],
    ];
    for (const [input, message] of cases) {
      const asked = askedQuestionsOf(input);
      expect(asked.ok).toBe(false);
      if (!asked.ok) expect(asked.error).toContain(message);
    }
  });
});

describe('answersForAgent', () => {
  it('pairs each question with its answer, marks skipped ones, and adds the extra note', () => {
    const asked = askedQuestionsOf({
      intro: 'x',
      questions: [
        { question: 'Which issue?', answer: { type: 'choice', options: ['A', 'B'] } },
        { question: 'Who owns it?' },
        { question: 'Which labs?', answer: { type: 'multi', options: ['Chem', 'Heme'] } },
      ],
    });
    if (!asked.ok) throw new Error(asked.error);
    expect(
      answersForAgent(asked.form, {
        q1: 'B',
        q2: '  ',
        q3: ['Chem', 'Heme'],
        anything_else: 'Ask Kelvin.',
      })
    ).toBe(
      'Q: Which issue?\nA: B\n\nQ: Who owns it?\nA: (skipped — no answer given)\n\nQ: Which labs?\nA: Chem, Heme\n\nAlso: Ask Kelvin.'
    );
  });

  it('hands a conversational reply back as it was written', () => {
    const asked = askedQuestionsOf({ intro: 'Where should this go?' });
    if (!asked.ok) throw new Error(asked.error);
    expect(answersForAgent(asked.form, { reply: 'Put it on CIO-25.' })).toBe('Put it on CIO-25.');
    expect(answersForAgent(asked.form, {})).toBe('Answered, with nothing filled in.');
  });
});
