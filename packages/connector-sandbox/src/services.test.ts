/**
 * The pure half of code project services: an image reference read the
 * way `docker pull` reads it, an allow-list rule normalized from however
 * an operator typed it, the most specific rule winning a match, and the
 * environment a running service announces itself with.
 */

import {
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
