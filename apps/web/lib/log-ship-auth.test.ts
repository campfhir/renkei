import { authorizeLogShipment } from './log-ship-auth';

function requestWithAuth(header?: string): Request {
  return new Request('http://renkei.test/api/logs', {
    method: 'POST',
    headers: header ? { authorization: header } : {},
  });
}

describe('authorizeLogShipment', () => {
  const originalKey = process.env.LOG_SHIP_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.LOG_SHIP_API_KEY;
    else process.env.LOG_SHIP_API_KEY = originalKey;
  });

  it('fails closed when no key is configured', () => {
    delete process.env.LOG_SHIP_API_KEY;
    expect(authorizeLogShipment(requestWithAuth('Bearer anything'))).toBe(false);
  });

  it('fails closed when the configured value is only whitespace/commas', () => {
    process.env.LOG_SHIP_API_KEY = ' , ,';
    expect(authorizeLogShipment(requestWithAuth('Bearer '))).toBe(false);
  });

  it('accepts the configured key', () => {
    process.env.LOG_SHIP_API_KEY = 'sekret-1';
    expect(authorizeLogShipment(requestWithAuth('Bearer sekret-1'))).toBe(true);
  });

  it('accepts a case-insensitive scheme and surrounding whitespace', () => {
    process.env.LOG_SHIP_API_KEY = 'sekret-1';
    expect(authorizeLogShipment(requestWithAuth('bearer  sekret-1 '))).toBe(true);
  });

  it('rejects a wrong key', () => {
    process.env.LOG_SHIP_API_KEY = 'sekret-1';
    expect(authorizeLogShipment(requestWithAuth('Bearer sekret-2'))).toBe(false);
  });

  it('rejects a configured key sent as a prefix or superstring', () => {
    process.env.LOG_SHIP_API_KEY = 'sekret-1';
    expect(authorizeLogShipment(requestWithAuth('Bearer sekret'))).toBe(false);
    expect(authorizeLogShipment(requestWithAuth('Bearer sekret-1-extra'))).toBe(false);
  });

  it('rejects a missing Authorization header and non-bearer schemes', () => {
    process.env.LOG_SHIP_API_KEY = 'sekret-1';
    expect(authorizeLogShipment(requestWithAuth())).toBe(false);
    expect(authorizeLogShipment(requestWithAuth('Basic sekret-1'))).toBe(false);
  });

  it('accepts any key in a comma-separated rotation list', () => {
    process.env.LOG_SHIP_API_KEY = 'old-key, new-key';
    expect(authorizeLogShipment(requestWithAuth('Bearer old-key'))).toBe(true);
    expect(authorizeLogShipment(requestWithAuth('Bearer new-key'))).toBe(true);
    expect(authorizeLogShipment(requestWithAuth('Bearer other'))).toBe(false);
  });
});
