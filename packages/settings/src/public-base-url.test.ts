import { publicBaseUrlRefusal } from './index';

describe('publicBaseUrlRefusal', () => {
  it('is silent outside production', () => {
    expect(publicBaseUrlRefusal({ NODE_ENV: 'development' })).toBeNull();
    expect(publicBaseUrlRefusal({})).toBeNull();
  });

  it('refuses a production boot with no declared origin', () => {
    expect(publicBaseUrlRefusal({ NODE_ENV: 'production' })).toMatch(/PUBLIC_BASE_URL is not set/);
    expect(publicBaseUrlRefusal({ NODE_ENV: 'production', PUBLIC_BASE_URL: '  ' })).toMatch(
      /not set/
    );
  });

  it('refuses a value that is not an absolute http(s) URL', () => {
    expect(
      publicBaseUrlRefusal({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'renkei.example' })
    ).toMatch(/absolute http\(s\) URL/);
  });

  it('accepts an https origin', () => {
    expect(
      publicBaseUrlRefusal({
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://renkei.example.com',
      })
    ).toBeNull();
  });
});
