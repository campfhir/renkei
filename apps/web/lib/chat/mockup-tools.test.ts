/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db for a tool that never touches it */
/**
 * chat_show_mockup's promises: a mockup that builds is answered with a
 * line that tells the model what the person now sees and not to repeat the
 * code; one that does not is the error the model sees, compiler message and
 * all; it never asks permission (read-only) and stores nothing.
 */

import { createLocalToolSet, type LocalToolContext } from './local-tools';
import { mockupTools } from './mockup-tools';
import { legacyCipher } from './content-crypto';

const context: LocalToolContext = {
  db: null as unknown as LocalToolContext['db'],
  tenantId: 't1',
  subject: 'u1',
  chatId: 'c1',
  cipher: legacyCipher,
  projectId: null,
  readOnly: false,
};

const set = createLocalToolSet(mockupTools());

describe('chat_show_mockup', () => {
  it('is offered, and read-only so it never asks', () => {
    expect(set.has('chat_show_mockup')).toBe(true);
    expect(set.readOnlyNames()).toContain('chat_show_mockup');
  });

  it('answers a mockup that builds with what the person sees', async () => {
    const result = await set.run(
      'chat_show_mockup',
      { title: 'Login', format: 'html', source: '<form class="p-6">…</form>', width: 390 },
      context
    );
    expect(result.isError).toBe(false);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('');
    expect(text).toContain('Login');
    expect(text).toContain('390px');
    expect(text).toContain('full screen');
    expect(text).toContain('do not paste its code again');
  });

  it('hands the compiler’s complaint back to the model', async () => {
    const result = await set.run(
      'chat_show_mockup',
      { title: 'Broken', format: 'react', source: 'export default () => <div>;' },
      context
    );
    expect(result.isError).toBe(true);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('');
    expect(text).toMatch(/did not compile/);
  });

  it('refuses a bad request before building anything', async () => {
    const result = await set.run(
      'chat_show_mockup',
      { title: 'x', format: 'pdf', source: 'x' },
      context
    );
    expect(result.isError).toBe(true);
  });
});
