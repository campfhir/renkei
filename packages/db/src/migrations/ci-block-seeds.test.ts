/**
 * The starter blocks migration 183 seeds still read as blocks and render
 * for both hosts: a seed that no longer reads would leave every
 * organization with a block its editor refuses to open.
 */

import { blockYaml, readBlockDefinition, sampleUse } from '@renkei/ci-blocks';
import { STARTER_BLOCKS } from './183-ci-blocks';

describe('the starter blocks', () => {
  it.each(STARTER_BLOCKS.map((block) => [block.key, block] as const))(
    '%s reads, says its own kind, and renders for Bitbucket and GitHub',
    (_key, block) => {
      const read = readBlockDefinition(block.definition);
      if (!read.ok) throw new Error(read.errors.join('\n'));
      expect(read.value.kind).toBe(block.kind);
      for (const host of ['bitbucket', 'github'] as const) {
        const yaml = blockYaml(read.value, host, sampleUse(read.value, block.name));
        expect(yaml.ok).toBe(true);
      }
    }
  );

  it('have keys a pipeline can name, each once', () => {
    const keys = STARTER_BLOCKS.map((block) => block.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z][a-z0-9-]{1,79}$/);
  });
});
