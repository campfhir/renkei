/**
 * What CodeQL asked of this package: the patterns that read block commands
 * and names stay linear on inputs built to make a backtracking pattern
 * crawl, and a report's body survives the shell with a backslash in it.
 */

import { execFileSync } from 'node:child_process';
import { placeholdersIn, reportCommand, substitute, targetFromRunner, trimDashes } from './index';

const fast = (work: () => unknown) => {
  const started = performance.now();
  work();
  return performance.now() - started;
};

describe('reading commands and names in linear time', () => {
  it('finds placeholders in a long run of ${ without crawling', () => {
    const hostile = '${'.repeat(50_000) + 'x';
    expect(fast(() => placeholdersIn(hostile))).toBeLessThan(500);
    expect(fast(() => substitute(hostile, 'github', {}, 'dev'))).toBeLessThan(500);
    // Ordinary commands read as before.
    expect(placeholdersIn('deploy ${input.name} to ${env} at ${commit}')).toEqual([
      'input.name',
      'env',
      'commit',
    ]);
    expect(substitute('echo ${branch} ${env}', 'bitbucket', {}, 'dev')).toBe(
      'echo $BITBUCKET_BRANCH dev'
    );
  });

  it('trims dashes from a long run of them without crawling', () => {
    const hostile = '-'.repeat(100_000) + 'a' + '-'.repeat(100_000);
    expect(fast(() => trimDashes(hostile))).toBeLessThan(500);
    expect(trimDashes('--onprem-app--')).toBe('onprem-app');
    expect(trimDashes('----')).toBe('');
    const runner = {
      host: 'bitbucket' as const,
      id: '1',
      name: 'r',
      labels: ['self.hosted', '-'.repeat(50_000) + 'x'],
      status: 'online' as const,
      busy: false,
    };
    expect(fast(() => targetFromRunner(runner))).toBeLessThan(500);
    expect(targetFromRunner({ ...runner, labels: ['self.hosted', '--DMZ--'] }).name).toBe('dmz');
  });
});

describe('a report through the shell', () => {
  it('keeps a backslash in the detail as it was', () => {
    const command = reportCommand(
      'bitbucket',
      { url: 'https://renkei.example/api/deployments/report', audience: 'https://renkei.example' },
      'dev',
      null,
      'failed',
      'C:\\\\builds'
    );
    // A curl that prints the body it was given.
    const out = execFileSync(
      'sh',
      ['-c', `curl() { while [ "$1" != -d ]; do shift; done; printf '%s' "$2"; }\n${command}`],
      { env: { PATH: '/usr/bin:/bin', BITBUCKET_COMMIT: 'abc1234' } }
    ).toString();
    expect(JSON.parse(out).detail).toBe('C:\\builds');
  });
});
