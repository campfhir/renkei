/**
 * The script-drafting pipeline's honesty checks, against the REAL sandbox:
 * a drafted script only reaches the admin if it compiles as a function AND
 * runs clean on the very sample it was written for. The model is mocked;
 * the sandbox is not — that boundary is the thing under test.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let modelReply = '';
jest.mock('@renkei/agent-llm', () => ({
  resolveAgentLlm: jest.fn(async () => ({
    ok: true,
    val: {
      provider: {
        complete: async () => ({
          ok: true,
          val: {
            content: [{ type: 'text', text: modelReply }],
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 10 },
          },
        }),
      },
      maxOutputTokens: 512,
    },
  })),
}));

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { suggestCleanerScript } from './suggest-script';

// The lib never touches the db beyond resolveAgentLlm (mocked), so an
// empty object suffices.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const db = {} as Kysely<DB>;

const SAMPLE = [
  'Hi team, the deploy is done.',
  'Follow NEMS: Facebook | WeChat | Instagram',
  'See you tomorrow.',
].join('\n');

describe('suggestCleanerScript', () => {
  it('returns a drafted script pre-flown on the sample', async () => {
    modelReply = JSON.stringify({
      name: 'Strip social row',
      script:
        "(email) => email.text.split('\\n').filter((l) => !l.startsWith('Follow NEMS:')).join('\\n')",
      rationale: 'Drops the fixed social-links row.',
    });

    const result = await suggestCleanerScript(db, 'tenant-1', SAMPLE, '');
    if ('error' in result) throw new Error(result.error);
    expect(result.name).toBe('Strip social row');
    // The server already ran it — the admin sees the before/after instantly.
    expect(result.sampleOutput).toBe('Hi team, the deploy is done.\nSee you tomorrow.');
  });

  it('rejects a draft that does not compile as a function', async () => {
    modelReply = JSON.stringify({ name: 'x', script: "'not a function'", rationale: 'r' });
    const result = await suggestCleanerScript(db, 'tenant-1', SAMPLE, '');
    expect('error' in result && result.error).toContain('does not compile');
  });

  it('rejects a draft that crashes on its own motivating sample', async () => {
    modelReply = JSON.stringify({
      name: 'x',
      script: "(email) => { throw new Error('boom'); }",
      rationale: 'r',
    });
    const result = await suggestCleanerScript(db, 'tenant-1', SAMPLE, '');
    expect('error' in result && result.error).toContain('failed on your own sample');
  });
});
