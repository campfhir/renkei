/**
 * A sub-agent's model is the orchestrating model's to pick, so the person's
 * token limit for the picked model is checked there too: the turn's own
 * check saw only the model the chat started on.
 */

const checkTokenLimit = jest.fn();
jest.mock('@renkei/settings', () => ({
  checkTokenLimit: (...args: unknown[]) => checkTokenLimit(...args),
  tokenLimitMessage: () => 'You have reached the weekly token limit for the model Big.',
}));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { pickSubagentLlm } from './subagent';
import type { LocalToolContext } from './local-tools';

const MODELS = [
  { id: 'model-big', label: 'Big', provider: 'openai', model: 'big-1', isDefault: false },
];
// Only the fields pickSubagentLlm reads.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const context = {
  subject: 'auth0|ann',
  llm: { modelConfigId: 'model-small' },
} as unknown as LocalToolContext;

beforeEach(() => checkTokenLimit.mockReset());

describe('a sub-agent on another model', () => {
  it('is refused when the person is over that model’s token limit, before the model is resolved', async () => {
    checkTokenLimit.mockResolvedValue({ period: 'week' });
    const resolve = jest.fn();
    const picked = await pickSubagentLlm(context, 'Big', MODELS, resolve);
    expect(picked.ok).toBe(false);
    expect(checkTokenLimit).toHaveBeenCalledWith('auth0|ann', 'model-big');
    expect(resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(picked)).toContain('weekly token limit for the model Big');
  });

  it('asks nothing more of the turn’s own model, which the turn already checked', async () => {
    const picked = await pickSubagentLlm(context, '', MODELS, jest.fn());
    expect(picked.ok).toBe(true);
    expect(checkTokenLimit).not.toHaveBeenCalled();
  });
});
