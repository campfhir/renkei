/**
 * A file a tool hands back through `_meta.renkeiDocuments` reaches the
 * store with the summary and keywords the model gave beside it, or with
 * none — never with a half-digest a missing summary would make.
 */

import { artifactsOfMeta } from './turn-runner';

describe('artifactsOfMeta', () => {
  it('carries a digest given beside the file, and none when the summary is missing', () => {
    const files = artifactsOfMeta(
      {
        renkeiDocuments: [
          {
            mediaType: 'text/markdown',
            dataBase64: 'IyBOb3Rlcw==',
            title: 'notes.md',
            summary: 'Notes from the rollout review.',
            keywords: ['rollout', 'review'],
          },
          { mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', keywords: ['chart'] },
        ],
      },
      'chat_write_file',
      2
    );
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      filename: 'notes.md',
      digest: { summary: 'Notes from the rollout review.', keywords: ['rollout', 'review'] },
    });
    expect(files[1]?.filename).toBe('chat_write_file-2-2.png');
    expect(files[1]?.digest).toBeNull();
  });
});
