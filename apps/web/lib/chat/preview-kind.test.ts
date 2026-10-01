import { PREVIEW_MAX_BYTES, previewKind } from './preview-kind';

function file(
  filename: string,
  contentType: string,
  extra: Partial<{ sizeBytes: number; extractStatus: string }> = {}
) {
  return { filename, contentType, sizeBytes: 1000, extractStatus: 'done', ...extra };
}

describe('previewKind', () => {
  it('reads the content type first', () => {
    expect(previewKind(file('a', 'image/png'))).toBe('image');
    expect(previewKind(file('a', 'application/pdf'))).toBe('pdf');
    expect(
      previewKind(
        file('a', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      )
    ).toBe('docx');
    expect(
      previewKind(file('a', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
    ).toBe('sheet');
    expect(previewKind(file('a', 'text/csv'))).toBe('sheet');
    expect(previewKind(file('a', 'text/plain'))).toBe('text');
    expect(previewKind(file('a', 'application/json'))).toBe('text');
  });

  it('falls back to the extension for a file stored as octet-stream', () => {
    const octet = 'application/octet-stream';
    expect(previewKind(file('report.PDF', octet))).toBe('pdf');
    expect(previewKind(file('memo.docx', octet))).toBe('docx');
    expect(previewKind(file('q4.xlsx', octet))).toBe('sheet');
    expect(previewKind(file('notes.md', octet))).toBe('text');
  });

  it('draws a deck as its slide, and falls back to extracted text for a legacy file', () => {
    const pptx = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    expect(previewKind(file('deck.pptx', pptx))).toBe('pptx');
    expect(previewKind(file('old.ppt', 'application/vnd.ms-powerpoint'))).toBe('extract');
    expect(
      previewKind(
        file('old.ppt', 'application/vnd.ms-powerpoint', { extractStatus: 'unsupported' })
      )
    ).toBeNull();
    expect(
      previewKind(file('archive.zip', 'application/zip', { extractStatus: 'unsupported' }))
    ).toBeNull();
  });

  it('does not preview a file past the size limit', () => {
    expect(
      previewKind(file('big.pdf', 'application/pdf', { sizeBytes: PREVIEW_MAX_BYTES + 1 }))
    ).toBeNull();
  });
});
