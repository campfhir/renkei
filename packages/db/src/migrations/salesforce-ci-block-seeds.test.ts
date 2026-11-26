/**
 * The Salesforce blocks migration 200 seeds read as blocks and render for
 * both hosts, and their commands are what a shell and Node accept: a seed
 * that no longer reads would leave every organization with a block its
 * editor refuses to open, and one whose script is broken fails every
 * deploy.
 */

import { execFileSync } from 'node:child_process';
import { Script } from 'node:vm';
import {
  blockYaml,
  placeholdersIn,
  readBlockDefinition,
  sampleUse,
  substitute,
} from '@renkei/ci-blocks';
import { STARTER_BLOCKS } from './183-ci-blocks';
import { FABRIC_STARTER_BLOCKS } from './189-fabric-ci-blocks';
import { SALESFORCE_STARTER_BLOCKS } from './200-salesforce-ci-blocks';

const blocks = SALESFORCE_STARTER_BLOCKS.map((block) => [block.key, block] as const);

/** The block's commands as a GitHub job would run them, every input at its default. */
function scriptOf(block: (typeof SALESFORCE_STARTER_BLOCKS)[number]): string {
  const read = readBlockDefinition(block.definition);
  if (!read.ok) throw new Error(read.errors.join('\n'));
  const values = Object.fromEntries(
    read.value.inputs.map((input) => [input.name, input.default ?? ''])
  );
  return substitute(read.value.commands, 'github', values, 'production');
}

describe('the Salesforce starter blocks', () => {
  it.each(blocks)(
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

  it.each(blocks)('%s is a script sh parses, with JavaScript that compiles', (_key, block) => {
    const script = scriptOf(block);
    execFileSync('sh', ['-n'], { input: script });
    execFileSync('bash', ['-n'], { input: script });
    const javascript = /<<'JS'\n([\s\S]*?)\nJS/.exec(script)?.[1] ?? '';
    expect(javascript.length).toBeGreaterThan(0);
    expect(() => new Script(javascript)).not.toThrow();
  });

  it.each(blocks)('%s leaves no placeholder unfilled', (_key, block) => {
    expect(placeholdersIn(scriptOf(block))).toEqual([]);
  });

  it('only the check is a dry run', () => {
    const [validate, deploy] = SALESFORCE_STARTER_BLOCKS.map(scriptOf);
    expect(validate).toContain('--dry-run');
    expect(deploy).not.toContain('--dry-run');
  });

  it('do not take a key an earlier migration seeded', () => {
    const earlier = [...STARTER_BLOCKS, ...FABRIC_STARTER_BLOCKS].map((block) => block.key);
    const keys = SALESFORCE_STARTER_BLOCKS.map((block) => block.key);
    expect(keys).toEqual(['salesforce-validate', 'salesforce-deploy']);
    for (const key of keys) expect(earlier).not.toContain(key);
  });
});
