import { previewUserLabel } from './user-label';

describe('previewUserLabel', () => {
  it('keeps an email and never reads it up', async () => {
    const read = jest.fn();
    await expect(previewUserLabel(read, 'ann@example.com')).resolves.toBe('ann@example.com');
    expect(read).not.toHaveBeenCalled();
  });

  it('shows an accountId as the display name', async () => {
    await expect(
      previewUserLabel(async () => ({ displayName: 'Ann Lee' }), '5b10a2844c20165700ede21g')
    ).resolves.toBe('Ann Lee');
  });

  it('never falls back to the accountId', async () => {
    for (const read of [async () => null, async () => Promise.reject(new Error('x'))]) {
      await expect(previewUserLabel(read, '5b10a2844c20165700ede21g')).resolves.toBe(
        'the selected person'
      );
    }
  });
});
