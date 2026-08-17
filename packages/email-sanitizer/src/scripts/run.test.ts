/**
 * The sandbox's whole case rests on four properties: scripts can transform,
 * scripts cannot reach the host, runaway scripts die at the deadline, and
 * a bad return is an error — never silently adopted output.
 */

import { runCleanerScript } from './run';

const input = {
  text: 'Hello team.\nFollow NEMS: Facebook | WeChat\nBye.',
  subject: 'Deploy done',
  fromAddress: 'scott@nems.org',
  fromName: 'Scott',
};

describe('runCleanerScript', () => {
  it('transforms text with real logic, not just literals', async () => {
    const result = await runCleanerScript(
      `(email) => email.text
         .split('\\n')
         .filter((line) => !line.startsWith('Follow NEMS:'))
         .join('\\n')`,
      input
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toBe('Hello team.\nBye.');
  });

  it('hands the script the header fields, null when absent', async () => {
    const result = await runCleanerScript(
      `(email) => [email.subject, email.replyToAddress, String(email.messageId)].join('|')`,
      { ...input, replyToAddress: 'no-reply@relay.example' }
    );
    expect(result.ok).toBe(true);
    // messageId was not supplied → null, so a script can branch on absence.
    if (result.ok) expect(result.val).toBe('Deploy done|no-reply@relay.example|null');
  });

  it('gives the guest no host surface at all', async () => {
    const result = await runCleanerScript(
      `() => [
         typeof require, typeof process, typeof fetch,
         typeof globalThis.Buffer, typeof setTimeout,
       ].join(',')`,
      input
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val).toBe('undefined,undefined,undefined,undefined,undefined');
    }
  });

  it('kills an infinite loop at the deadline instead of hanging', async () => {
    const started = Date.now();
    const result = await runCleanerScript('() => { while (true) {} }', input, { deadlineMs: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('TIMEOUT');
    // Well under a second: the interrupt fired, nothing waited it out.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('rejects a non-string return rather than adopting it', async () => {
    const result = await runCleanerScript('(email) => ({ text: email.text })', input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('SCRIPT_THREW');
  });

  it('rejects source that is not a function', async () => {
    const result = await runCleanerScript("'just a string'", input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('SCRIPT_THREW');
    expect(result.detail).toContain('must be a function');
  });

  it('surfaces a thrown error with its message', async () => {
    const result = await runCleanerScript("() => { throw new Error('nope'); }", input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('SCRIPT_THREW');
    expect(result.detail).toContain('nope');
  });

  it('caps output size', async () => {
    const result = await runCleanerScript("() => 'x'.repeat(9000)", input, {
      maxOutputChars: 1_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('BAD_OUTPUT');
  });
});
