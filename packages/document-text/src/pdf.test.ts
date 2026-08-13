/**
 * PDF extraction against real pdfjs — the one dependency this package keeps,
 * so the integration is worth proving rather than mocking.
 *
 * The fixture is BUILT here, not committed: a valid PDF is plain text plus a
 * correct xref table, so generating it keeps the repo free of binaries and
 * makes the test's subject legible in the diff.
 */

import { extractText } from './index';

/** A minimal single-page PDF with one text-showing operator. */
function buildPdf(text: string, pages = 1): Uint8Array {
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ');
  const objects: string[] = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${kids}]/Count ${pages}>>`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  for (let page = 0; page < pages; page += 1) {
    const stream = text ? `BT /F1 24 Tf 72 700 Td (${text}) Tj ET` : '';
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${5 + page * 2} 0 R/Resources<</Font<</F1 3 0 R>>>>>>`,
      `<</Length ${stream.length}>>stream\n${stream}\nendstream`
    );
  }

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe('pdf extraction', () => {
  it('reads text from a real PDF through pdfjs', async () => {
    const result = await extractText(buildPdf('Hello from a real PDF'), { fileName: 'memo.pdf' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.format).toBe('pdf');
      expect(result.val.text).toContain('Hello from a real PDF');
      expect(result.val.sections).toBe(1);
    }
  }, 30_000);

  it('does not libel a short but readable PDF as a scan', async () => {
    // The scanned check is per-page for exactly this reason: a one-line memo
    // is short AND perfectly readable, and an absolute document-wide floor
    // would flag it. (A page of two or three characters really is
    // indistinguishable from an empty scan, and is meant to be flagged.)
    const result = await extractText(buildPdf('Approved by Finance.'), {
      fileName: 'short.pdf',
    });
    expect(result.ok && result.val.notes).toEqual([]);
  }, 30_000);

  it('flags a page with no text layer as scanned instead of erroring', async () => {
    // A scan is a valid document we cannot read — reporting it lets the
    // caller index the filename and record why. There is no OCR here.
    const result = await extractText(buildPdf(''), { fileName: 'scan.pdf' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.notes).toContain('scanned-pdf');
      expect(result.val.text).toBe('');
    }
  }, 30_000);

  it('reports a malformed PDF as corrupt rather than throwing', async () => {
    const result = await extractText(new TextEncoder().encode('%PDF-1.4\nnot really a pdf'), {
      fileName: 'broken.pdf',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('CORRUPT');
  }, 30_000);
});
