import { parsePromptVariables } from '@/lib/chat/prompt-variables';
import { initialPromptAnswers, promptFormNodes, promptFormResult } from './prompt-form.model';

const BODY = [
  'Review {{file}} for {{focus:choice}} in {{areas:multi}}, severity {{severity:number}}. {{notes:longtext}}',
  '',
  '```variables',
  'file:',
  '  required: true',
  'focus:',
  '  options: [security, performance, readability]',
  '  default: security',
  'areas:',
  '  options: [api, ui, db]',
  '  default: [api]',
  'severity:',
  '  min: 1',
  '  max: 5',
  '```',
].join('\n');

const variables = parsePromptVariables(BODY);

describe('the form a prompt opens', () => {
  it('starts with each default filled in and nothing else', () => {
    expect(initialPromptAnswers(variables)).toEqual({ focus: 'security', areas: ['api'] });
  });

  it('draws one field per variable, in the order the prompt uses them', () => {
    expect(promptFormNodes(variables.fields).map((node) => node.name)).toEqual([
      'file',
      'focus',
      'areas',
      'severity',
      'notes',
    ]);
  });
});

describe('pressing Insert', () => {
  const answers = { ...initialPromptAnswers(variables), file: ' src/billing.ts ', severity: '3' };

  it('fills the template with the answers, trimmed, and leaves out the variables block', () => {
    expect(promptFormResult(variables, answers)).toEqual({
      ok: true,
      text: 'Review src/billing.ts for security in api, severity 3. ',
    });
  });

  it('is refused while a required answer is missing, and says which', () => {
    expect(promptFormResult(variables, { ...answers, file: '' })).toEqual({
      ok: false,
      fieldErrors: { file: 'Needs an answer.' },
    });
  });

  it('is refused for a number out of range, under that field only', () => {
    const result = promptFormResult(variables, { ...answers, severity: '9' });
    expect(result).toEqual({ ok: false, fieldErrors: { severity: 'Must be 5 or less.' } });
  });

  it('reads a list of picks as "a, b"', () => {
    const result = promptFormResult(variables, { ...answers, areas: ['api', 'db'] });
    expect(result.ok && result.text).toContain('in api, db,');
  });

  it('lets an optional answer stay empty', () => {
    const result = promptFormResult(variables, { file: 'a.ts' });
    expect(result.ok).toBe(true);
  });
});
