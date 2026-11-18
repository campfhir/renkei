/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Drafting a block with the organization's model: a usable answer comes
 * back as the form's contents; an answer with problems goes back once with
 * them; two unusable answers end in words the editor shows.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@renkei/agent-llm', () => ({ resolveAgentLlm: jest.fn() }));

import { resolveAgentLlm } from '@renkei/agent-llm';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { draftBlock } from './draft-block';

const complete = jest.fn();
const answer = (text: string) => ({
  ok: true,
  val: { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: {} },
});
const good = {
  key: 'deploy-compose',
  name: 'Deploy with Compose',
  description: 'Pulls and starts the Compose project on the runner.',
  definition: { kind: 'deploy', runsOn: { type: 'target' }, commands: 'docker compose up -d' },
};

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
  complete.mockReset();
  jest
    .mocked(resolveAgentLlm)
    .mockResolvedValue({
      ok: true,
      val: { provider: { complete }, maxOutputTokens: 8000 },
    } as never);
});
afterEach(() => resetDataStore());

it('fills the form from a usable answer, even one wrapped in a fence', async () => {
  complete.mockResolvedValueOnce(
    answer(`Here it is:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``)
  );
  expect(await draftBlock('Deploy our Compose project on the on-prem runner')).toMatchObject({
    key: 'deploy-compose',
    definition: { kind: 'deploy', runsOn: { type: 'target' }, commands: 'docker compose up -d' },
  });
});

it('sends an answer with problems back once, with them, and takes the corrected one', async () => {
  complete
    .mockResolvedValueOnce(
      answer(
        JSON.stringify({
          ...good,
          definition: { ...good.definition, commands: 'deploy ${input.host}' },
        })
      )
    )
    .mockResolvedValueOnce(answer(JSON.stringify(good)));
  expect(await draftBlock('Deploy our Compose project on the on-prem runner')).toMatchObject({
    key: 'deploy-compose',
  });
  const second = complete.mock.calls[1][0].messages.at(-1).content[0].text;
  expect(second).toContain('The commands use ${input.host}, but the block has no input “host”.');
});

it('gives up after two unusable answers, saying why', async () => {
  complete.mockResolvedValue(answer('I cannot help with that.'));
  expect(await draftBlock('Deploy our Compose project on the on-prem runner')).toEqual({
    error:
      'The draft still had problems: Answer with one JSON object, as described. Try describing it differently, or write it by hand.',
  });
  expect(complete).toHaveBeenCalledTimes(2);
});

it('asks for more than a word, and says when the organization has no model', async () => {
  expect(await draftBlock('deploy')).toEqual({ error: 'Describe the block in a sentence or two.' });
  jest.mocked(resolveAgentLlm).mockResolvedValue({ ok: false, err: { type: 'NO_MODEL' } } as never);
  expect(await draftBlock('Deploy our Compose project on the on-prem runner')).toEqual({
    error: 'No model is set up for the organization; an admin adds one under Agent models.',
  });
});
