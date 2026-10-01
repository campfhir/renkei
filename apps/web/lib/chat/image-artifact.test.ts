/**
 * Putting a picture back inside the call that drew it: the file carries the
 * id of the tool_results row that kept it, and among a row's images the one
 * the result names is the call's own.
 */

import { imageArtifactFor } from './image-artifact';
import type { AttachmentView } from './views';

const file = (
  id: string,
  filename: string,
  messageId: string | null,
  contentType = 'image/png'
): AttachmentView => ({
  id,
  filename,
  contentType,
  sizeBytes: 100,
  extractStatus: 'none',
  messageId,
});

describe('imageArtifactFor', () => {
  const rows = new Map([
    ['call-1', 'row-a'],
    ['call-2', 'row-a'],
    ['call-3', 'row-b'],
  ]);

  it('is the image the row kept for this call', () => {
    const artifacts = [file('f1', 'bear.png', 'row-a'), file('f2', 'fox.png', 'row-b')];
    expect(imageArtifactFor('call-3', rows, artifacts, 'Generated fox.png with Painter')?.id).toBe(
      'f2'
    );
  });

  it('picks, among one row’s images, the one the result names', () => {
    const artifacts = [file('f1', 'bear.png', 'row-a'), file('f2', 'fox.png', 'row-a')];
    expect(imageArtifactFor('call-1', rows, artifacts, 'Generated bear.png with Painter')?.id).toBe(
      'f1'
    );
    expect(imageArtifactFor('call-2', rows, artifacts, 'Generated fox.png with Painter')?.id).toBe(
      'f2'
    );
  });

  it('falls back to the row’s first image when the result names none', () => {
    const artifacts = [file('f1', 'bear.png', 'row-a'), file('f2', 'fox.png', 'row-a')];
    expect(imageArtifactFor('call-1', rows, artifacts, 'something else')?.id).toBe('f1');
  });

  it('is nothing for a call with no result row, another row’s files, or non-images', () => {
    const artifacts = [
      file('f1', 'notes.csv', 'row-a', 'text/csv'),
      file('f2', 'fox.png', 'row-b'),
    ];
    expect(imageArtifactFor('call-1', rows, artifacts, 'Generated fox.png')).toBeNull();
    expect(imageArtifactFor('unknown', rows, artifacts, '')).toBeNull();
    expect(
      imageArtifactFor('call-1', rows, [file('f3', 'a.png', null)], 'Generated a.png')
    ).toBeNull();
  });
});
