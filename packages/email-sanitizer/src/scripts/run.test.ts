/**
 * The sandbox's whole case rests on four properties: scripts can transform,
 * scripts cannot reach the host, runaway scripts die at the deadline, and
 * a bad return is an error — never silently adopted output.
 */

import { runCleanerScript, validateCleanerScriptSource } from './run';

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

describe('content kinds inside the sandbox', () => {
  it('tells the script which kind it is holding', async () => {
    const script = `(email) => email.kind`;
    const asEvent = await runCleanerScript(script, { ...input, kind: 'evt' });
    expect(asEvent.ok && asEvent.val).toBe('evt');
  });

  it('defaults to mail, so a script written before invites existed is unchanged', async () => {
    const result = await runCleanerScript(`(email) => email.kind`, input);
    expect(result.ok && result.val).toBe('msg');
  });

  it('hands an invite its own fields', async () => {
    const script = `(item) => [item.organizer, item.attendees.join('|'), item.location, item.isOnline].join(' / ')`;
    const result = await runCleanerScript(script, {
      ...input,
      kind: 'evt',
      organizer: 'Dana Reyes',
      attendees: ['Evan Jeing', 'Sam Ortiz'],
      location: 'Room 4B',
      isOnline: true,
    });
    expect(result.ok && result.val).toBe('Dana Reyes / Evan Jeing|Sam Ortiz / Room 4B / true');
  });

  it('exposes the same object as `item` and as `email`', async () => {
    // `email` is kept for scripts already written against it; `item` exists
    // because that name does not lie when the thing in hand is a meeting.
    const result = await runCleanerScript(`() => String(item === email)`, {
      ...input,
      kind: 'evt',
    });
    expect(result.ok && result.val).toBe('true');
  });

  it('gives calendar fields harmless empties on a message', async () => {
    const script = `(email) => JSON.stringify([email.attendees, email.organizer, email.isOnline])`;
    const result = await runCleanerScript(script, input);
    expect(result.ok && result.val).toBe('[[],null,false]');
  });

  it('still sandboxes an invite script — no host reach, budget enforced', async () => {
    const reaching = await runCleanerScript(`() => typeof fetch + typeof require`, {
      ...input,
      kind: 'evt',
    });
    expect(reaching.ok && reaching.val).toBe('undefinedundefined');

    const looping = await runCleanerScript(`() => { while (true) {} }`, { ...input, kind: 'evt' });
    expect(looping.ok).toBe(false);
  });
});

describe('script forms', () => {
  it('accepts a plain function declaration, which is the documented shape', async () => {
    const result = await runCleanerScript(
      `function (email) { return email.text.toUpperCase(); }`,
      input
    );
    expect(result.ok && result.val).toBe(input.text.toUpperCase());
  });

  it('accepts a named function too', async () => {
    const result = await runCleanerScript(`function clean(email) { return 'ok'; }`, input);
    expect(result.ok && result.val).toBe('ok');
  });

  it('tolerates a trailing semicolon', async () => {
    // Every formatter appends one. Without this the script is a syntax
    // error whose only symptom in production is a last_error nobody reads —
    // Prettier reformatting the checked-in library is how it was found.
    const result = await runCleanerScript(`function (email) { return 'ok'; };`, input);
    expect(result.ok && result.val).toBe('ok');
  });

  it('validates a semicolon-terminated function at save time', async () => {
    const valid = await validateCleanerScriptSource(`(email) => email.text;`);
    expect(valid.ok).toBe(true);
  });

  it('still rejects something that is not a function', async () => {
    const valid = await validateCleanerScriptSource(`{ notAFunction: true }`);
    expect(valid.ok).toBe(false);
  });
});
