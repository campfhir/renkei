/**
 * The Services page's payload: a start's two text boxes read as
 * variables, a bad line named rather than dropped, and the card's
 * summary from a view.
 */

import { parseServiceStartPayload, summarizeServices } from './services';

describe('parseServiceStartPayload', () => {
  it('reads the name, the image and both text boxes', () => {
    expect(
      parseServiceStartPayload({
        name: ' db ',
        image: ' postgres:16 ',
        env: 'POSTGRES_PASSWORD=test\nPOSTGRES_DB=app\n',
        exports: 'DATABASE_URL="postgres://postgres:test@{host}:{port}/app"',
      })
    ).toEqual({
      name: 'db',
      image: 'postgres:16',
      env: { POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'app' },
      exports: { DATABASE_URL: 'postgres://postgres:test@{host}:{port}/app' },
    });
    expect(parseServiceStartPayload({ name: 'cache', image: 'redis' })).toEqual({
      name: 'cache',
      image: 'redis',
      env: {},
      exports: {},
    });
  });

  it('refuses a bad name, a missing image, and a line that is not a variable', () => {
    expect(parseServiceStartPayload({ name: 'DB', image: 'postgres' })).toHaveProperty('error');
    expect(parseServiceStartPayload({ name: 'db', image: '' })).toHaveProperty('error');
    const broken = parseServiceStartPayload({ name: 'db', image: 'postgres', env: 'not a line' });
    expect(broken).toHaveProperty(
      'error',
      expect.stringContaining('Not read as variables: line 1')
    );
    expect(parseServiceStartPayload(null)).toEqual({ error: 'Malformed payload' });
  });
});

describe('summarizeServices', () => {
  it('counts what runs and names everything', () => {
    const service = (name: string, status: 'running' | 'stopped') => ({
      id: name,
      name,
      image: 'x',
      status,
      error: null,
      host: null,
      ports: [],
      exportNames: [],
      createdAt: '',
      lastUsedAt: '',
      expiresAt: '',
    });
    expect(
      summarizeServices({
        enabled: true,
        services: [service('db', 'running'), service('old', 'stopped')],
        allowed: ['docker.io/library/postgres', 'myorg.azurecr.io'],
      })
    ).toEqual({ enabled: true, running: 1, names: ['db', 'old'], allowedCount: 2 });
  });
});
