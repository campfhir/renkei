import { enhanceLogger, log, registerLogContext, registerLogSink, type LogSink } from './index';

type Captured = { level: string; message: string; fields: Record<string, unknown> };

function capture(): Captured[] {
  const records: Captured[] = [];
  const sink = (level: string): LogSink[keyof LogSink] =>
    ((message: string, fields?: Record<string, unknown>) => {
      records.push({ level, message, fields: fields ?? {} });
    }) as LogSink[keyof LogSink];
  registerLogSink({
    debug: sink('debug'),
    info: sink('info'),
    warn: sink('warn'),
    error: sink('error'),
  });
  return records;
}

afterEach(() => {
  registerLogContext(() => undefined);
});

test('a warning carries a stack that starts at the code that logged it', () => {
  const records = capture();
  log.warn('thing failed: {message}', { component: 'connectors/test', message: 'nope' });
  const stack = String(records[0].fields.stack);
  expect(stack.split('\n')[0]).toBe('Error');
  expect(stack).toContain('index.test.ts');
  expect(stack).not.toMatch(/packages\/logging\/src\/index\.ts:\d/);
});

test('an error keeps its own stack and is written as its message', () => {
  const records = capture();
  const failure = new Error('connection reset');
  log.error('upload failed', { component: 'connectors/test', error: failure });
  expect(records[0].fields.error).toBe('connection reset');
  expect(records[0].fields.stack).toBe(failure.stack);
});

test('info records get no stack', () => {
  const records = capture();
  log.info('started', { component: 'connectors/test' });
  expect(records[0].fields).not.toHaveProperty('stack');
});

test('the request context is added under the call’s own fields', () => {
  const records = capture();
  registerLogContext(() => ({ user: 'person@example.com', browserAgent: 'Safari', page: '/chat' }));
  log.warn('thing failed', { component: 'connectors/test', page: '/override' });
  expect(records[0].fields).toMatchObject({
    user: 'person@example.com',
    browserAgent: 'Safari',
    page: '/override',
    component: 'connectors/test',
  });
});

test('an undefined field does not blank the request context', () => {
  const records = capture();
  registerLogContext(() => ({ page: '/chat', browserAgent: 'Safari' }));
  log.warn('thing failed', { component: 'connectors/test', page: undefined });
  expect(records[0].fields).toMatchObject({ page: '/chat', browserAgent: 'Safari' });
});

test('an enhanced logger adds the context to every record, and a stack to warnings and errors only', () => {
  const seen: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const target = {
    debug: (_m: string, f?: Record<string, unknown>) =>
      seen.push({ level: 'debug', fields: f ?? {} }),
    info: (_m: string, f?: Record<string, unknown>) =>
      seen.push({ level: 'info', fields: f ?? {} }),
    warn: (_m: string, f?: Record<string, unknown>) =>
      seen.push({ level: 'warn', fields: f ?? {} }),
    error: (_m: string, f?: Record<string, unknown>) =>
      seen.push({ level: 'error', fields: f ?? {} }),
  };
  registerLogContext(() => ({ user: 'person@example.com', page: '/chat' }));
  const logger = enhanceLogger(target);
  logger.info('started', { component: 'x' });
  logger.warn('failed', { component: 'x' });
  expect(seen[0].fields).toMatchObject({ user: 'person@example.com', page: '/chat' });
  expect(seen[0].fields).not.toHaveProperty('stack');
  expect(String(seen[1].fields.stack)).toContain('index.test.ts');
});
