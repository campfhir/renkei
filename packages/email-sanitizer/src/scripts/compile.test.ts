/**
 * The strip has to be faithful: what the sandbox runs must behave exactly
 * like what the admin wrote. So these tests check the OUTPUT RUNS and
 * produces the same answer, not merely that the transform returned
 * something.
 */

import { compileCleanerScript } from './compile';
import { runCleanerScript, validateCleanerScriptSource } from './run';

const input = {
  text: 'Hello team.\nFollow NEMS: Facebook | WeChat\nBye.',
  subject: 'Deploy done',
  fromAddress: 'scott@nems.org',
  fromName: 'Scott',
};

describe('compileCleanerScript', () => {
  it('strips annotations and the result still runs in the sandbox', async () => {
    const source = `function (email: { text: string }): string {
      const lines: string[] = email.text.split('\\n');
      return lines.filter((line: string) => !line.startsWith('Follow NEMS:')).join('\\n');
    }`;
    const compiled = await compileCleanerScript(source);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    expect(compiled.val.compiled).not.toContain('string[]');
    expect(compiled.val.transformed).toBe(true);

    const run = await runCleanerScript(compiled.val.compiled, input);
    expect(run.ok && run.val).toBe('Hello team.\nBye.');
  });

  it('leaves plain JavaScript semantically alone', async () => {
    const source = `(email) => email.text.toUpperCase()`;
    const compiled = await compileCleanerScript(source);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const run = await runCleanerScript(compiled.val.compiled, input);
    expect(run.ok && run.val).toBe(input.text.toUpperCase());
  });

  it('keeps the output valid as a function expression', async () => {
    // The sandbox wraps the source in parentheses, so a transform that
    // turned the expression into a statement would break at run time
    // rather than here. Check the contract the runner actually relies on.
    const compiled = await compileCleanerScript(
      `function (email: { text: string }): string { return email.text; }`
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const valid = await validateCleanerScriptSource(compiled.val.compiled);
    expect(valid.ok).toBe(true);
  });

  it('supports interfaces and type aliases declared alongside the function', async () => {
    const source = `function (email: any): string {
      type Line = string;
      const keep: Line[] = email.text.split('\\n').slice(0, 1);
      return keep.join('\\n');
    }`;
    const compiled = await compileCleanerScript(source);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const run = await runCleanerScript(compiled.val.compiled, input);
    expect(run.ok && run.val).toBe('Hello team.');
  });

  it('rejects an enum rather than emitting runtime code that is not in the source', async () => {
    const result = await compileCleanerScript(`function (email) { enum E { A } return 'x'; }`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.err.type).toBe('UNSUPPORTED');
    expect(result.detail).toContain('enum');
  });

  it('reports a syntax error instead of storing something unrunnable', async () => {
    const result = await compileCleanerScript(`function (email: { return }`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.err.type).toBe('SYNTAX');
  });
});
