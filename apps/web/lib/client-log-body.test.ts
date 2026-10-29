import { parseClientLogBody } from './client-log-body';

describe('parseClientLogBody', () => {
  it('keeps a well-formed line', () => {
    expect(
      parseClientLogBody({
        level: 'error',
        component: 'chat/ocr',
        message: 'POST /api/chat/attachments/ocr failed (500)',
        page: '/chat/abc?tab=files',
        stack: 'Error: x\n  at y',
        attrs: { status: 500, retried: false, path: '/api/chat/attachments/ocr' },
      })
    ).toEqual({
      level: 'error',
      component: 'chat/ocr',
      message: 'POST /api/chat/attachments/ocr failed (500)',
      page: '/chat/abc',
      stack: 'Error: x\n  at y',
      attrs: { status: 500, retried: false, path: '/api/chat/attachments/ocr' },
    });
  });

  it('refuses a line without a level, message or a plain component', () => {
    expect(parseClientLogBody(null)).toBeNull();
    expect(parseClientLogBody({ level: 'fatal', component: 'a', message: 'm' })).toBeNull();
    expect(parseClientLogBody({ level: 'warn', component: 'a', message: '' })).toBeNull();
    expect(parseClientLogBody({ level: 'warn', component: '../x y', message: 'm' })).toBeNull();
  });

  it('drops the names the server stamps, nested values and placeholders', () => {
    const body = parseClientLogBody({
      level: 'warn',
      component: 'preferences',
      message: 'save {subject} refused',
      attrs: { subject: 'someone-else', accountId: 'x', nested: { a: 1 }, ok: 'yes', 'bad key': 1 },
    });
    expect(body?.message).toBe('save subject refused');
    expect(body?.attrs).toEqual({ ok: 'yes' });
  });

  it('bounds long values', () => {
    const body = parseClientLogBody({
      level: 'info',
      component: 'x',
      message: 'm'.repeat(10_000),
      attrs: { detail: 'd'.repeat(10_000) },
    });
    expect(body?.message).toHaveLength(2_000);
    expect(body?.attrs.detail).toHaveLength(2_000);
  });
});
