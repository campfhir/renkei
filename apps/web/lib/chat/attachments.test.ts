import { massUploadManifest, NEEDS_OCR, type AttachmentRow } from './attachments';

function row(over: Partial<AttachmentRow>): AttachmentRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    ownerSubject: 'u',
    chatId: 'c',
    projectId: null,
    messageId: null,
    blobKey: 'k',
    filename: 'cv.pdf',
    contentType: 'application/pdf',
    sizeBytes: 10,
    extractStatus: 'done',
    origin: 'upload',
    createdAt: new Date(0),
    ...over,
  };
}

describe('massUploadManifest', () => {
  it('lists every file by id without inlining any text', () => {
    const block = massUploadManifest([
      row({ id: 'a', filename: 'one.pdf' }),
      row({ id: 'b', filename: 'scan.pdf', extractStatus: NEEDS_OCR }),
      row({ id: 'c', filename: 'bad.pdf', extractStatus: 'ocr_failed' }),
    ]);
    expect(block.type).toBe('text');
    const text = block.type === 'text' ? block.text : '';
    expect(text).toContain('count="3"');
    expect(text).toContain('id=a name="one.pdf"');
    expect(text).toContain('id=b name="scan.pdf" type=application/pdf size=10 text=ocr-pending');
    expect(text).toContain('id=c name="bad.pdf" type=application/pdf size=10 text=ocr_failed');
    expect(text).toContain('chat_read_attachment');
  });
});
