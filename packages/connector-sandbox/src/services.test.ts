/**
 * The pure half of code project services: an image reference read the
 * way `docker pull` reads it, an allow-list rule normalized from however
 * an operator typed it, the most specific rule winning a match, and the
 * environment a running service announces itself with.
 */

import {
  compileLogMatch,
  filterLogEntries,
  renderLogEntries,
  sinceOf,
  mergeLogEntries,
  normalizeStamp,
  parseStampedLogs,
  sinceAfter,
  imageRuleMatches,
  matchImageRule,
  normalizeImageRule,
  parseImageReference,
  renderServiceExport,
  serviceEnvPrefix,
  serviceEnvironment,
  validateServiceEnv,
  validateServiceExports,
  validateServiceName,
} from './services';

function image(ref: string) {
  const parsed = parseImageReference(ref);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.image;
}

function rule(pattern: string) {
  const normalized = normalizeImageRule(pattern);
  if (!normalized.ok) throw new Error(normalized.message);
  return normalized.rule;
}

describe('parseImageReference', () => {
  it('reads a bare official image as docker.io/library with latest', () => {
    expect(image('postgres')).toEqual({
      host: 'docker.io',
      path: 'library/postgres',
      tag: 'latest',
      digest: null,
      canonical: 'docker.io/library/postgres:latest',
    });
  });

  it('keeps a tag, a namespace and a registry apart', () => {
    expect(image('postgres:16').canonical).toBe('docker.io/library/postgres:16');
    expect(image('pgvector/pgvector:pg16').canonical).toBe('docker.io/pgvector/pgvector:pg16');
    expect(image('myorg.azurecr.io/team/api:1.2.3')).toMatchObject({
      host: 'myorg.azurecr.io',
      path: 'team/api',
      tag: '1.2.3',
    });
    expect(image('localhost:5000/api').canonical).toBe('localhost:5000/api:latest');
    expect(image('index.docker.io/library/redis:7').host).toBe('docker.io');
  });

  it('reads a digest', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const parsed = image(`mcr.microsoft.com/mssql/server@${digest}`);
    expect(parsed.tag).toBeNull();
    expect(parsed.digest).toBe(digest);
    expect(parsed.canonical).toBe(`mcr.microsoft.com/mssql/server@${digest}`);
  });

  it('refuses what docker would refuse', () => {
    for (const bad of ['', 'Postgres', 'a//b', 'redis:', 'x@sha256:12', 'a b', 'bad_/name']) {
      expect(parseImageReference(bad).ok).toBe(false);
    }
  });
});

describe('normalizeImageRule', () => {
  it('reads a whole registry, a namespace and one repository', () => {
    expect(rule('MyOrg.azurecr.io')).toEqual({
      host: 'myorg.azurecr.io',
      path: '',
      pattern: 'myorg.azurecr.io',
    });
    expect(rule('myorg.azurecr.io/platform/*').pattern).toBe('myorg.azurecr.io/platform/*');
    expect(rule('pgvector/*').pattern).toBe('docker.io/pgvector/*');
    expect(rule('docker.io/pgvector/*').pattern).toBe('docker.io/pgvector/*');
    expect(rule('postgres').pattern).toBe('docker.io/library/postgres');
    expect(rule('hub.docker.com/library/redis/').pattern).toBe('docker.io/library/redis');
    expect(rule('localhost:5000').pattern).toBe('localhost:5000');
  });

  it('drops a tag or digest and says so', () => {
    const tagged = normalizeImageRule('postgres:16');
    expect(tagged).toMatchObject({ ok: true, dropped: 'the tag 16' });
    if (tagged.ok) expect(tagged.rule.pattern).toBe('docker.io/library/postgres');
    const digested = normalizeImageRule(`redis@sha256:${'b'.repeat(64)}`);
    expect(digested).toMatchObject({ ok: true, dropped: 'the digest' });
  });

  it('refuses a wildcard anywhere but at the end, and a tagged namespace', () => {
    expect(normalizeImageRule('myorg.azurecr.io/*/api').ok).toBe(false);
    expect(normalizeImageRule('myorg.azurecr.io/*').ok).toBe(false);
    expect(normalizeImageRule('myorg.azurecr.io/team:1/*').ok).toBe(false);
    expect(normalizeImageRule('').ok).toBe(false);
  });
});

describe('matching', () => {
  it('a registry rule allows everything on it and nothing elsewhere', () => {
    const registry = rule('myorg.azurecr.io');
    expect(imageRuleMatches(registry, image('myorg.azurecr.io/team/api:1'))).toBe(true);
    expect(imageRuleMatches(registry, image('myorg.azurecr.io/x'))).toBe(true);
    expect(imageRuleMatches(registry, image('other.azurecr.io/team/api'))).toBe(false);
    expect(imageRuleMatches(registry, image('postgres'))).toBe(false);
  });

  it('a namespace rule allows what is under it only', () => {
    const namespace = rule('myorg.azurecr.io/platform/*');
    expect(imageRuleMatches(namespace, image('myorg.azurecr.io/platform/api'))).toBe(true);
    expect(imageRuleMatches(namespace, image('myorg.azurecr.io/platform/deep/er'))).toBe(true);
    expect(imageRuleMatches(namespace, image('myorg.azurecr.io/platformx/api'))).toBe(false);
    expect(imageRuleMatches(namespace, image('myorg.azurecr.io/platform'))).toBe(false);
  });

  it('a repository rule allows any tag of that one repository', () => {
    const postgres = rule('postgres');
    expect(imageRuleMatches(postgres, image('postgres:16'))).toBe(true);
    expect(imageRuleMatches(postgres, image('docker.io/library/postgres'))).toBe(true);
    expect(imageRuleMatches(postgres, image('postgres/postgres'))).toBe(false);
    expect(imageRuleMatches(postgres, image('bitnami/postgresql'))).toBe(false);
  });

  it('the most specific rule wins, and none means refused', () => {
    const rules = [
      { id: 'r', pattern: 'myorg.azurecr.io' },
      { id: 'n', pattern: 'myorg.azurecr.io/platform/*' },
      { id: 'p', pattern: 'myorg.azurecr.io/platform/api' },
      { id: 'pg', pattern: 'docker.io/library/postgres' },
    ];
    expect(matchImageRule(rules, image('myorg.azurecr.io/platform/api:2'))?.id).toBe('p');
    expect(matchImageRule(rules, image('myorg.azurecr.io/platform/web'))?.id).toBe('n');
    expect(matchImageRule(rules, image('myorg.azurecr.io/other/web'))?.id).toBe('r');
    expect(matchImageRule(rules, image('postgres:16'))?.id).toBe('pg');
    expect(matchImageRule(rules, image('redis'))).toBeNull();
    expect(matchImageRule([{ pattern: 'not a rule!' }], image('redis'))).toBeNull();
  });
});

describe('what a service is called and handed', () => {
  it('names', () => {
    expect(validateServiceName('db')).toEqual({ ok: true, name: 'db' });
    expect(validateServiceName(' pg-16 ')).toEqual({ ok: true, name: 'pg-16' });
    for (const bad of ['', 'DB', '1db', '-db', 'a'.repeat(33), 'my_db']) {
      expect(validateServiceName(bad).ok).toBe(false);
    }
  });

  it('container env', () => {
    expect(validateServiceEnv(undefined)).toEqual({ ok: true, env: {} });
    expect(validateServiceEnv({ POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'app' })).toEqual({
      ok: true,
      env: { POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'app' },
    });
    expect(validateServiceEnv({ 'bad name': 'x' }).ok).toBe(false);
    expect(validateServiceEnv({ X: 1 }).ok).toBe(false);
    expect(validateServiceEnv([]).ok).toBe(false);
  });

  it('exports refuse the sandbox-set and reserved names', () => {
    expect(validateServiceExports({ DATABASE_URL: 'postgres://a:b@{host}:{port}/app' })).toEqual({
      ok: true,
      exports: { DATABASE_URL: 'postgres://a:b@{host}:{port}/app' },
    });
    expect(validateServiceExports({ PATH: '/x' }).ok).toBe(false);
    expect(validateServiceExports({ SERVICE_DB_HOST: 'x' }).ok).toBe(false);
    expect(validateServiceExports({ URL: '' }).ok).toBe(false);
  });

  it('announces a running service to the project', () => {
    expect(serviceEnvPrefix('pg-16')).toBe('SERVICE_PG_16');
    expect(renderServiceExport('redis://{host}:{port}/0', { host: '10.0.0.5', port: 6379 })).toBe(
      'redis://10.0.0.5:6379/0'
    );
    expect(
      serviceEnvironment([
        {
          name: 'db',
          host: '172.20.0.3',
          ports: [5432],
          exports: { DATABASE_URL: 'postgres://app:app@{host}:{port}/app' },
        },
        { name: 'broker', host: '172.20.0.4', ports: [15672, 5672], exports: {} },
        { name: 'plain', host: '172.20.0.5', ports: [], exports: {} },
      ])
    ).toEqual({
      SERVICE_DB_HOST: '172.20.0.3',
      SERVICE_DB_PORT: '5432',
      SERVICE_DB_PORTS: '5432',
      DATABASE_URL: 'postgres://app:app@172.20.0.3:5432/app',
      SERVICE_BROKER_HOST: '172.20.0.4',
      SERVICE_BROKER_PORT: '5672',
      SERVICE_BROKER_PORTS: '5672,15672',
      SERVICE_PLAIN_HOST: '172.20.0.5',
    });
  });
});

describe('a combined tail', () => {
  it('reads stamped lines, pads the stamp, and carries a bare line on the last stamp', () => {
    const text = '2026-09-23T15:27:56.4718Z ready\n2026-09-23T15:27:57Z second line\ncontinued\n';
    expect(parseStampedLogs('db', text)).toEqual([
      { service: 'db', at: '2026-09-23T15:27:56.471800000Z', line: 'ready' },
      { service: 'db', at: '2026-09-23T15:27:57.000000000Z', line: 'second line' },
      { service: 'db', at: '2026-09-23T15:27:57.000000000Z', line: 'continued' },
    ]);
    expect(normalizeStamp('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00.000000000Z');
  });

  it('merges services in time order and keeps the newest past the cap', () => {
    const db = parseStampedLogs('db', '2026-09-23T10:00:01Z a\n2026-09-23T10:00:03Z c\n');
    const cache = parseStampedLogs('cache', '2026-09-23T10:00:02Z b\n2026-09-23T10:00:04Z d\n');
    expect(mergeLogEntries([db, cache]).entries.map((entry) => entry.line)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    const capped = mergeLogEntries([db, cache], 2);
    expect(capped.truncated).toBe(true);
    expect(capped.entries.map((entry) => entry.line)).toEqual(['c', 'd']);
  });

  it('turns a stamp into the engine’s since, one nanosecond on', () => {
    expect(sinceAfter('2026-09-23T15:27:56.471800000Z')).toBe('1790177276.471800001');
    expect(sinceAfter('2026-09-23T15:27:56.999999999Z')).toBe('1790177277.000000000');
    expect(sinceAfter('2026-09-23T15:27:56Z')).toBe('1790177276.000000001');
    expect(sinceAfter('yesterday')).toBeNull();
    expect(sinceAfter(5)).toBeNull();
  });
});

describe('since and match', () => {
  it('reads a duration back from now, a stamp one nanosecond on, or nothing', () => {
    const now = Date.parse('2026-09-23T16:00:00Z');
    expect(sinceOf('5m', now)).toEqual({ ok: true, since: `${now / 1000 - 300}.000000000` });
    expect(sinceOf('2h', now)).toEqual({ ok: true, since: `${now / 1000 - 7200}.000000000` });
    expect(sinceOf('2026-09-23T15:27:56Z', now)).toEqual({
      ok: true,
      since: '1790177276.000000001',
    });
    expect(sinceOf(undefined, now)).toEqual({ ok: true, since: null });
    expect(sinceOf('', now)).toEqual({ ok: true, since: null });
    expect(sinceOf('yesterday', now).ok).toBe(false);
    expect(sinceOf(5, now).ok).toBe(false);
  });

  it('keeps matching lines only, case-insensitively, and renders them reusably', () => {
    const entries = parseStampedLogs(
      'db',
      '2026-09-23T10:00:01Z FATAL: password not set\n2026-09-23T10:00:02Z ready\n2026-09-23T10:00:03Z ERROR: relation missing\n'
    );
    const match = compileLogMatch('fatal|error');
    expect(match.ok).toBe(true);
    if (!match.ok) return;
    const kept = filterLogEntries(entries, match.match);
    expect(kept.map((entry) => entry.line)).toEqual([
      'FATAL: password not set',
      'ERROR: relation missing',
    ]);
    expect(renderLogEntries(kept, false)).toBe(
      '2026-09-23T10:00:01.000000000Z FATAL: password not set\n2026-09-23T10:00:03.000000000Z ERROR: relation missing'
    );
    expect(renderLogEntries(kept.slice(0, 1), true)).toBe(
      '2026-09-23T10:00:01.000000000Z db FATAL: password not set'
    );
    expect(filterLogEntries(entries, null)).toHaveLength(3);
    expect(compileLogMatch('(').ok).toBe(false);
    expect(compileLogMatch('x'.repeat(600)).ok).toBe(false);
  });
});
