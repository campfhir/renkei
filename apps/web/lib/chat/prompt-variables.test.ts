import { fillPromptTemplate, hasPromptVariables, parsePromptVariables } from './prompt-variables';

const names = (body: string) => parsePromptVariables(body).fields.map((f) => f.name);

describe('a prompt with no variables', () => {
  it('has no form and is sent as written', () => {
    const parsed = parsePromptVariables('Explain this repository.');
    expect(parsed.fields).toEqual([]);
    expect(parsed.template).toBe('Explain this repository.');
    expect(hasPromptVariables('Explain this repository.')).toBe(false);
  });
});

describe('inline placeholders', () => {
  it('ask for text unless a type is given', () => {
    const [field] = parsePromptVariables('Fix {{bug}}').fields;
    expect(field).toEqual({ name: 'bug', label: 'Bug', type: 'text', required: false });
  });

  it('take their type from {{name:type}}, and accept the common words for it', () => {
    const types = parsePromptVariables(
      [
        '{{a:longtext}} {{b:textarea}} {{c:number}} {{d:date}} {{e:radio}} {{f:checkbox}}',
        '',
        '```variables',
        'e:',
        '  options: [x, y]',
        'f:',
        '  options: [x, y]',
        '```',
      ].join('\n')
    ).fields.map((f) => f.type);
    expect(types).toEqual(['longtext', 'longtext', 'number', 'date', 'choice', 'multi']);
  });

  it('are asked once, in order of first appearance, however often they are used', () => {
    expect(names('{{b}} then {{a}} then {{b}} again')).toEqual(['b', 'a']);
  });

  it('use the typed mention when an earlier one had no type', () => {
    expect(parsePromptVariables('{{x}} and {{x:number}}').fields[0]?.type).toBe('number');
  });

  it('label an underscored name as words', () => {
    expect(parsePromptVariables('{{target_branch}}').fields[0]?.label).toBe('Target branch');
  });

  it('are left alone when they are not names', () => {
    expect(names('{{ not a name }} {{1abc}} ${{x}}')).toEqual(['x']);
  });
});

describe('the trailing variables block', () => {
  const body = [
    'Review {{file}} for {{focus:choice}}. Notes: {{notes:longtext}}',
    '',
    '```variables',
    'file:',
    '  required: true',
    '  help: Path in the repository',
    'focus:',
    '  options: [security, performance, readability]',
    '  default: security',
    '```',
  ].join('\n');

  it('is not part of what is sent', () => {
    expect(parsePromptVariables(body).template).toBe(
      'Review {{file}} for {{focus:choice}}. Notes: {{notes:longtext}}'
    );
  });

  it('makes a variable required, with help', () => {
    const file = parsePromptVariables(body).fields.find((f) => f.name === 'file');
    expect(file).toMatchObject({ required: true, help: 'Path in the repository', type: 'text' });
  });

  it('gives a choice its options and a default', () => {
    const parsed = parsePromptVariables(body);
    expect(parsed.fields.find((f) => f.name === 'focus')?.options).toEqual([
      'security',
      'performance',
      'readability',
    ]);
    expect(parsed.defaults).toEqual({ focus: 'security' });
    expect(parsed.problems).toEqual([]);
  });

  it('can carry the type instead of the placeholder, and the inline type wins when both are given', () => {
    const parsed = parsePromptVariables(
      '{{n}} {{m:number}}\n\n```variables\nn:\n  type: number\n  min: 1\n  max: 5\nm:\n  type: date\n```'
    );
    expect(parsed.fields[0]).toMatchObject({ type: 'number', min: 1, max: 5 });
    expect(parsed.fields[1]?.type).toBe('number');
  });

  it('checks a multi default against its options', () => {
    const parsed = parsePromptVariables(
      '{{t:multi}}\n\n```variables\nt:\n  options: [a, b]\n  default: [a, z]\n```'
    );
    expect(parsed.defaults).toEqual({ t: ['a'] });
  });

  it('is only read at the very end of the prompt', () => {
    const parsed = parsePromptVariables('```variables\nx:\n  required: true\n```\nthen {{x}}');
    expect(parsed.fields[0]?.required).toBe(false);
  });
});

describe('what cannot be read does not break the prompt', () => {
  it('a choice with no options asks for text and says why', () => {
    const parsed = parsePromptVariables('{{c:choice}}');
    expect(parsed.fields[0]?.type).toBe('text');
    expect(parsed.problems).toEqual([
      '"c" is a choice but lists no options, asking for text instead.',
    ]);
  });

  it('an unknown type asks for text and says why', () => {
    const parsed = parsePromptVariables('{{c:colour}}');
    expect(parsed.fields[0]?.type).toBe('text');
    expect(parsed.problems[0]).toContain('unknown type "colour"');
  });

  it('broken YAML keeps the variables, loses the settings and reports it', () => {
    const parsed = parsePromptVariables('{{x}}\n\n```variables\nx: [unclosed\n```');
    expect(parsed.fields).toHaveLength(1);
    expect(parsed.problems[0]).toContain('not valid YAML');
  });

  it('a block entry nothing uses is reported', () => {
    const parsed = parsePromptVariables('{{x}}\n\n```variables\ny:\n  required: true\n```');
    expect(parsed.problems).toEqual(['"y" is in the variables block but not used in the prompt.']);
  });

  it('asks at most ten questions and leaves the rest as written', () => {
    const body = Array.from({ length: 12 }, (_, i) => `{{v${i}}}`).join(' ');
    const parsed = parsePromptVariables(body);
    expect(parsed.fields).toHaveLength(10);
    expect(parsed.problems[0]).toContain('at most 10');
    expect(fillPromptTemplate(parsed.template, parsed.fields, { v0: 'a' })).toBe(
      'a ' + Array.from({ length: 9 }, () => '').join(' ') + ' {{v10}} {{v11}}'
    );
  });
});

describe('filling the template', () => {
  const parsed = parsePromptVariables(
    'Fix {{bug}} in {{areas:multi}}, severity {{sev:number}}.\n\n```variables\nareas:\n  options: [api, ui]\n```'
  );

  it('puts each answer where its placeholder was', () => {
    expect(
      fillPromptTemplate(parsed.template, parsed.fields, {
        bug: 'the login loop',
        areas: ['api', 'ui'],
        sev: '3',
      })
    ).toBe('Fix the login loop in api, ui, severity 3.');
  });

  it('leaves nothing for an unanswered optional variable', () => {
    expect(fillPromptTemplate(parsed.template, parsed.fields, { bug: 'x' })).toBe(
      'Fix x in , severity .'
    );
  });

  it('fills every use of a variable', () => {
    const twice = parsePromptVariables('{{a}} and {{a}}');
    expect(fillPromptTemplate(twice.template, twice.fields, { a: 'go' })).toBe('go and go');
  });
});
