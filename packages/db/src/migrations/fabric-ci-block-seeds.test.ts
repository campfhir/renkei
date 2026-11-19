/**
 * The Fabric blocks migration 189 seeds read as blocks and render for both
 * hosts, and their commands are what a shell and Python accept: a seed
 * that no longer reads would leave every organization with a block its
 * editor refuses to open, and one whose script is broken fails every
 * deploy.
 */

import { execFileSync } from 'node:child_process';
import { blockYaml, readBlockDefinition, sampleUse, substitute } from '@renkei/ci-blocks';
import { FABRIC_STARTER_BLOCKS } from './189-fabric-ci-blocks';

describe('the Fabric starter blocks', () => {
  it.each(FABRIC_STARTER_BLOCKS.map((block) => [block.key, block] as const))(
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

  it.each(FABRIC_STARTER_BLOCKS.map((block) => [block.key, block] as const))(
    '%s is a script bash parses, with Python that compiles',
    (_key, block) => {
      const read = readBlockDefinition(block.definition);
      if (!read.ok) throw new Error(read.errors.join('\n'));
      const values = Object.fromEntries(
        read.value.inputs.map((input) => [input.name, input.default ?? 'Sales'])
      );
      const script = substitute(read.value.commands, 'github', values, 'production');
      execFileSync('bash', ['-n'], { input: script });
      const python = /<<'PY'\n([\s\S]*?)\nPY/.exec(script)?.[1] ?? '';
      expect(python.length).toBeGreaterThan(0);
      execFileSync('python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], {
        input: python,
      });
    }
  );

  it('do not take a key migration 183 seeded', () => {
    expect(FABRIC_STARTER_BLOCKS.map((block) => block.key)).toEqual([
      'fabric-validate',
      'fabric-deploy',
    ]);
  });
});
