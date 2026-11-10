import {
  askedQuestionsOf,
  flattenFormFields,
  type QuestionAnswerValue,
  type QuestionField,
} from '@renkei/agents';
import {
  checkBeforeSend,
  initialQuestion,
  isPicked,
  otherChoiceOf,
  pickedOption,
  questionNumber,
  questionReducer,
  sendLabel,
  sendOutcomeOf,
  showsSkipHint,
  toggledOther,
  withOtherAnswer,
  type QuestionAction,
  type QuestionState,
} from './question-actions.model';

/** The batch an agent asked through ask_person, as the card's form. */
function batchFields(): QuestionField[] {
  const asked = askedQuestionsOf({
    intro: 'ATLAS Lab Harvest went live on Azure 10/17–10/19; two things need a home.',
    questions: [
      {
        question: 'Should the ATLAS go-live status go on CIO-5, CIO-25 or CIO-26?',
        context: 'John Vo: "a great first day post go-live"; 837 lab orders on 10/19.',
        answer: { type: 'choice', options: ['CIO-5', 'CIO-25', 'CIO-26'] },
      },
      {
        question: 'Does the xCures SFTP / IP-allowlist work need a CIO-39 update?',
        context: 'SYS-2597, Kelvin, 10/19.',
        answer: { type: 'choice', options: ['Yes', 'No'] },
      },
    ],
  });
  if (!asked.ok) throw new Error(asked.error);
  return flattenFormFields(asked.form);
}

const FIELDS = batchFields();
const [Q1, Q2] = FIELDS;

function fold(actions: QuestionAction[], from: QuestionState = initialQuestion): QuestionState {
  return actions.reduce(questionReducer, from);
}

const multi: QuestionField = {
  name: 'q3',
  label: 'Which comments?',
  type: 'multi',
  required: false,
  options: ['decision 1', 'risk 2'],
  other: 'Something else',
};

describe('a question card asking a batch', () => {
  it('numbers each question, keeps its evidence beside it, and says blanks are skipped', () => {
    expect(FIELDS.map((field) => field.name)).toEqual(['q1', 'q2', 'anything_else']);
    expect(questionNumber(Q1.name)).toBe('1');
    expect(questionNumber('anything_else')).toBeNull();
    expect(Q1.context).toContain('837 lab orders on 10/19.');
    expect(Q2.context).toBe('SYS-2597, Kelvin, 10/19.');
    expect(showsSkipHint(FIELDS)).toBe(true);
    expect(sendLabel(FIELDS)).toBe('Send the answers');
  });

  it('does not offer to skip a lone question or a required one', () => {
    expect(showsSkipHint([Q1])).toBe(false);
    expect(showsSkipHint([Q1, { ...Q2, required: true }])).toBe(false);
    expect(sendLabel([])).toBe('Send');
  });

  it('a radio choice replaces the answer; "Something else" opens a box only once picked', () => {
    let value: QuestionAnswerValue | undefined = pickedOption(Q1, undefined, 'CIO-25');
    expect(isPicked(Q1, value, 'CIO-25')).toBe(true);
    expect(otherChoiceOf(Q1, value).checked).toBe(false);

    value = toggledOther(Q1, value);
    expect(otherChoiceOf(Q1, value)).toMatchObject({ checked: true, own: '' });
    expect(isPicked(Q1, value, 'CIO-25')).toBe(false);

    value = withOtherAnswer(Q1, value, 'A new CIO-41 issue for the Azure cutover');
    expect(value).toBe('Something else: A new CIO-41 issue for the Azure cutover');
    expect(otherChoiceOf(Q1, value).own).toBe('A new CIO-41 issue for the Azure cutover');
  });

  it('"Something else" picked but left empty is stopped before sending: "Say what it is."', () => {
    const state = fold([{ type: 'answered', name: 'q1', value: toggledOther(Q1, undefined) }]);
    const marks = checkBeforeSend(FIELDS, state.answers);
    expect(marks).toEqual({ q1: 'Say what it is.' });
    const marked = questionReducer(state, { type: 'checkFailed', fieldErrors: marks ?? {} });
    expect(marked.fieldErrors).toEqual({ q1: 'Say what it is.' });
    expect(marked.busy).toBe(false);
  });

  it('writing in the box clears its mark, and only its own', () => {
    const marked = fold([
      { type: 'checkFailed', fieldErrors: { q1: 'Say what it is.', q2: 'Pick one.' } },
      { type: 'answered', name: 'q1', value: 'Something else: CIO-41' },
    ]);
    expect(marked.fieldErrors).toEqual({ q2: 'Pick one.' });
  });

  it('sends the answers given, with a skipped question simply absent', () => {
    const state = fold([
      { type: 'answered', name: 'q1', value: 'Something else: A new CIO-41 issue' },
      { type: 'answered', name: 'anything_else', value: 'Kelvin owns the SFTP piece.' },
    ]);
    expect(checkBeforeSend(FIELDS, state.answers)).toBeNull();
    expect(state.answers).toEqual({
      q1: 'Something else: A new CIO-41 issue',
      anything_else: 'Kelvin owns the SFTP piece.',
    });
    expect(state.answers).not.toHaveProperty('q2');
  });

  it('a card with no fields sends without a check', () => {
    expect(checkBeforeSend([], {})).toBeNull();
  });

  it('a multi choice adds and removes picks, with at most one "Something else"', () => {
    let value: QuestionAnswerValue | undefined = pickedOption(multi, undefined, 'risk 2');
    value = pickedOption(multi, value, 'decision 1');
    expect(value).toEqual(['risk 2', 'decision 1']);
    value = toggledOther(multi, value);
    value = withOtherAnswer(multi, value, 'risk 9');
    expect(value).toEqual(['risk 2', 'decision 1', 'Something else: risk 9']);
    value = withOtherAnswer(multi, value, 'risk 10');
    expect(value).toEqual(['risk 2', 'decision 1', 'Something else: risk 10']);
    // Unticking "Something else" takes the written answer away with it.
    value = toggledOther(multi, value);
    expect(value).toEqual(['risk 2', 'decision 1']);
    expect(pickedOption(multi, value, 'risk 2')).toEqual(['decision 1']);
  });
});

describe('what a send leaves on the card', () => {
  const sent = fold([
    { type: 'checkFailed', fieldErrors: { q1: 'old' } },
    { type: 'outcome', outcome: { kind: 'saved-late', warning: 'old notice' } },
    { type: 'sent' },
  ]);

  it('sending clears the last marks and messages and holds the button', () => {
    expect(sent).toMatchObject({ busy: true, fieldErrors: {}, notice: null, error: null });
  });

  it('answered: nothing to show — the card goes on the refresh', () => {
    const outcome = sendOutcomeOf(200, { status: 'answered' });
    expect(outcome).toEqual({ kind: 'answered' });
    const settled = fold([{ type: 'outcome', outcome }, { type: 'settled' }], sent);
    expect(settled).toMatchObject({ busy: false, notice: null, error: null });
  });

  it('saved but slow to resume (502): says so as a notice, not an error', () => {
    const outcome = sendOutcomeOf(502, {
      status: 'answered',
      warning: 'Your answer is saved; the run will resume automatically shortly.',
    });
    expect(outcome.kind).toBe('saved-late');
    const state = questionReducer(sent, { type: 'outcome', outcome });
    expect(state.notice).toBe('Your answer is saved; the run will resume automatically shortly.');
    expect(state.error).toBeNull();
  });

  it('a 422 marks the fields the server named, with its message', () => {
    const outcome = sendOutcomeOf(422, {
      error: 'Some answers need another look.',
      issues: [
        { name: 'q1', label: 'Should…?', message: 'Pick one of the choices offered.' },
        { name: 7, message: 'ignored' },
        'junk',
      ],
    });
    const state = questionReducer(sent, { type: 'outcome', outcome });
    expect(state.error).toBe('Some answers need another look.');
    expect(state.fieldErrors).toEqual({ q1: 'Pick one of the choices offered.' });
  });

  it('a refusal with no message, or no body, still says it failed', () => {
    expect(sendOutcomeOf(409, { error: 'Item was already answered' })).toEqual({
      kind: 'refused',
      error: 'Item was already answered',
      fieldErrors: {},
    });
    expect(sendOutcomeOf(500, null)).toEqual({
      kind: 'refused',
      error: 'Request failed (500)',
      fieldErrors: {},
    });
    expect(sendOutcomeOf(502, {})).toMatchObject({ kind: 'refused' });
  });
});
