import { flattenFormFields } from '@renkei/agents';
import { ASK_FORM_ANSWER_PREFIX, askFormAnswersText, parseAskFormRequest } from './ask-form';

const parsed = (input: unknown) => {
  const result = parseAskFormRequest(input);
  if (!result.ok) throw new Error(result.message);
  return result.request;
};

describe('a form the model asks for', () => {
  it('needs questions: a call with none is refused with the reason', () => {
    expect(parseAskFormRequest({})).toEqual({
      ok: false,
      message: 'chat_ask_form needs a list of questions to put in the form.',
    });
    expect(parseAskFormRequest({ questions: [] }).ok).toBe(false);
  });

  it('turns each flat question into a field of its type, in order', () => {
    const request = parsed({
      intro: 'Two things before I start.',
      questions: [
        { question: 'Which file?', type: 'text', help: 'A path' },
        { question: 'How urgent?', type: 'choice', options: ['low', 'high'] },
        { question: 'Which areas?', type: 'multi', options: ['api', 'ui', 'db'] },
        { question: 'How many?', type: 'number', min: 1, max: 5 },
      ],
    });
    expect(request.intro).toBe('Two things before I start.');
    const fields = flattenFormFields(request.form);
    expect(fields.map((f) => [f.label, f.type])).toEqual([
      ['Which file?', 'text'],
      ['How urgent?', 'choice'],
      ['Which areas?', 'multi'],
      ['How many?', 'number'],
      ['Anything else I should know?', 'longtext'],
    ]);
    expect(fields[0]).toMatchObject({ help: 'A path' });
    expect(fields[1]).toMatchObject({ options: ['low', 'high'], other: 'Something else' });
    expect(fields[3]).toMatchObject({ min: 1, max: 5 });
  });

  it('makes a question with no type a short text box', () => {
    const [field] = flattenFormFields(parsed({ questions: [{ question: 'Which file?' }] }).form);
    expect(field).toMatchObject({ type: 'text' });
  });

  it('shows yes/no as two radio buttons', () => {
    const [field] = flattenFormFields(
      parsed({ questions: [{ question: 'Run the tests?', type: 'yesno' }] }).form
    );
    expect(field).toMatchObject({ type: 'choice', options: ['Yes', 'No'] });
  });

  it('lets the model require a question, which no other question is', () => {
    const fields = flattenFormFields(
      parsed({
        questions: [{ question: 'Which file?', required: true }, { question: 'Why?' }],
      }).form
    );
    expect(fields.map((f) => f.required)).toEqual([true, false, false]);
  });

  it('says what is wrong with a question the model wrote badly', () => {
    expect(
      parseAskFormRequest({ questions: [{ question: 'Pick', type: 'choice', options: ['only'] }] })
    ).toEqual({ ok: false, message: 'Question 1: a choice answer needs at least two options.' });
    expect(parseAskFormRequest({ questions: [{ type: 'text' }] }).ok).toBe(false);
  });

  it('asks at most ten questions', () => {
    const questions = Array.from({ length: 11 }, (_, i) => ({ question: `Q${i}?` }));
    const result = parseAskFormRequest({ questions });
    expect(result.ok).toBe(false);
  });
});

describe('the answers the person sends back', () => {
  const request = parsed({
    questions: [
      { question: 'Which file?', type: 'text' },
      { question: 'Which areas?', type: 'multi', options: ['api', 'ui'] },
      { question: 'When?', type: 'date' },
    ],
  });

  it('are a message beginning "My answers:", each question with its answer', () => {
    const text = askFormAnswersText(request, { q1: 'src/a.ts', q2: ['api', 'ui'] });
    expect(text.startsWith(ASK_FORM_ANSWER_PREFIX)).toBe(true);
    expect(text).toContain('Q: Which file?\nA: src/a.ts');
    expect(text).toContain('Q: Which areas?\nA: api, ui');
  });

  it('mark a blank answer as skipped, and add the closing box only when it has something', () => {
    const blank = askFormAnswersText(request, { q1: 'x' });
    expect(blank).toContain('Q: When?\nA: (skipped — no answer given)');
    expect(blank).not.toContain('Also:');
    expect(askFormAnswersText(request, { q1: 'x', anything_else: 'Be brief.' })).toContain(
      'Also: Be brief.'
    );
  });
});
