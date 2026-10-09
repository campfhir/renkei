/**
 * The boot-time read of the delegate's address: both variables or
 * nothing, and a production process with nothing says so once.
 */

import { delegateConfigFromEnv, resetDelegateUnconfiguredReportForTests } from './transport';

describe('delegateConfigFromEnv', () => {
  beforeEach(() => resetDelegateUnconfiguredReportForTests());

  it('reads the pair and trims a trailing slash off the URL', () => {
    const reports: string[] = [];
    const config = delegateConfigFromEnv(
      { DELEGATE_WORKER_URL: 'http://delegate:8096/', DELEGATE_WORKER_API_KEY: ' k-1 ' },
      (message) => reports.push(message)
    );
    expect(config).toEqual({ url: 'http://delegate:8096', apiKey: 'k-1' });
    expect(reports).toEqual([]);
  });

  it('is null, silently, outside production when nothing is set', () => {
    const reports: string[] = [];
    expect(delegateConfigFromEnv({ NODE_ENV: 'development' }, (m) => reports.push(m))).toBeNull();
    expect(delegateConfigFromEnv({}, (m) => reports.push(m))).toBeNull();
    expect(reports).toEqual([]);
  });

  it('reports once, naming what is missing, when a production process has no delegate', () => {
    const reports: string[] = [];
    const env = { NODE_ENV: 'production', DELEGATE_WORKER_API_KEY: 'k-1' };
    expect(delegateConfigFromEnv(env, (m) => reports.push(m))).toBeNull();
    expect(delegateConfigFromEnv(env, (m) => reports.push(m))).toBeNull();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('DELEGATE_WORKER_URL not set in production');
    expect(reports[0]).not.toContain('DELEGATE_WORKER_API_KEY not set');
    expect(reports[0]).toContain('DELEGATE_UNCONFIGURED');
  });

  it('names both variables when neither is set', () => {
    const reports: string[] = [];
    expect(delegateConfigFromEnv({ NODE_ENV: 'production' }, (m) => reports.push(m))).toBeNull();
    expect(reports[0]).toContain('DELEGATE_WORKER_URL and DELEGATE_WORKER_API_KEY not set');
  });
});
