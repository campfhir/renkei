import { blobStoreConfig } from './config';
import { chatAttachmentKey } from './keys';

const AZURITE_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

describe('blobStoreConfig', () => {
  it('is unconfigured without a provider, with an unknown provider, or with missing credentials', () => {
    expect(blobStoreConfig({}).ok).toBe(false);
    expect(blobStoreConfig({ BLOB_STORE_PROVIDER: 's3' }).ok).toBe(false);
    expect(blobStoreConfig({ BLOB_STORE_PROVIDER: 'azure', AZURE_BLOB_ACCOUNT: 'a' }).ok).toBe(
      false
    );
  });

  it('reads the Azure settings with defaults', () => {
    const config = blobStoreConfig({
      BLOB_STORE_PROVIDER: 'Azure',
      AZURE_BLOB_ACCOUNT: 'acct',
      AZURE_BLOB_KEY: AZURITE_KEY,
    });
    if (!config.ok) throw new Error('expected ok');
    expect(config.val).toEqual({
      provider: 'azure',
      account: 'acct',
      key: AZURITE_KEY,
      container: 'renkei-chat',
      endpoint: 'https://acct.blob.core.windows.net',
    });
  });

  it('accepts an emulator endpoint and strips a trailing slash', () => {
    const config = blobStoreConfig({
      BLOB_STORE_PROVIDER: 'azure',
      AZURE_BLOB_ACCOUNT: 'devstoreaccount1',
      AZURE_BLOB_KEY: AZURITE_KEY,
      AZURE_BLOB_ENDPOINT: 'http://azurite:10000/devstoreaccount1/',
      AZURE_BLOB_CONTAINER: 'files',
    });
    if (!config.ok) throw new Error('expected ok');
    expect(config.val.endpoint).toBe('http://azurite:10000/devstoreaccount1');
    expect(config.val.container).toBe('files');
  });

  it('rejects a container name Azure would refuse', () => {
    expect(
      blobStoreConfig({
        BLOB_STORE_PROVIDER: 'azure',
        AZURE_BLOB_ACCOUNT: 'acct',
        AZURE_BLOB_KEY: AZURITE_KEY,
        AZURE_BLOB_CONTAINER: 'Not Valid',
      }).ok
    ).toBe(false);
  });
});

describe('chatAttachmentKey', () => {
  it('builds the key from two UUIDs and refuses anything else', () => {
    const key = chatAttachmentKey(
      '11111111-2222-3333-4444-555555555555',
      'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
    );
    if (!key.ok) throw new Error('expected ok');
    expect(key.val).toBe(
      'chat/11111111-2222-3333-4444-555555555555/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );
    expect(chatAttachmentKey('../etc', '11111111-2222-3333-4444-555555555555').ok).toBe(false);
  });
});
