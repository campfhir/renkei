/**
 * Word extraction. Most of these tests exist for the SKIP rules — the cases
 * where a naive extractor produces text that looks fine and is wrong.
 */

import { extractText } from './index';
import { buildDocx, buildZip, paragraph } from './test-support';

const textOf = async (bytes: Uint8Array): Promise<string> => {
  const result = await extractText(bytes);
  if (!result.ok) throw new Error(`extraction failed: ${result.err.type}`);
  return result.val.text;
};

describe('docx extraction', () => {
  it('reads paragraphs as lines', async () => {
    const bytes = buildDocx(paragraph('First line') + paragraph('Second line'));
    expect(await textOf(bytes)).toBe('First line\nSecond line');
  });

  it('drops deleted revision text but keeps insertions', async () => {
    // Indexing text the author explicitly removed is both a correctness and a
    // governance problem — the deleted words are, by definition, not the doc.
    const bytes = buildDocx(
      '<w:p><w:r><w:t xml:space="preserve">Ship </w:t></w:r>' +
        '<w:del><w:r><w:delText xml:space="preserve">never </w:delText></w:r></w:del>' +
        '<w:ins><w:r><w:t>on Friday</w:t></w:r></w:ins></w:p>'
    );
    expect(await textOf(bytes)).toBe('Ship on Friday');
  });

  it('does not emit mc:Fallback content twice', async () => {
    // The classic hand-rolled-docx bug: mc:Choice and mc:Fallback are two
    // renderings of the SAME content, so taking both duplicates every run.
    const bytes = buildDocx(
      '<w:p><mc:AlternateContent xmlns:mc="mc">' +
        '<mc:Choice><w:r><w:t>Quarterly result</w:t></w:r></mc:Choice>' +
        '<mc:Fallback><w:r><w:t>Quarterly result</w:t></w:r></mc:Fallback>' +
        '</mc:AlternateContent></w:p>'
    );
    expect(await textOf(bytes)).toBe('Quarterly result');
  });

  it('honours xml:space="preserve" so adjacent runs do not fuse', async () => {
    const bytes = buildDocx(
      '<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>'
    );
    expect(await textOf(bytes)).toBe('Hello world');
  });

  it('skips field codes, which are markup rather than prose', async () => {
    const bytes = buildDocx(
      '<w:p><w:r><w:instrText>MERGEFIELD Name \\* MERGEFORMAT</w:instrText></w:r>' +
        '<w:r><w:t>Dear reader</w:t></w:r></w:p>'
    );
    expect(await textOf(bytes)).toBe('Dear reader');
  });

  it('handles nested deletions inside insertions without re-enabling output', async () => {
    // A boolean skip flag would turn output back on at the inner close tag.
    const bytes = buildDocx(
      '<w:p><w:r><w:t xml:space="preserve">A </w:t></w:r>' +
        '<w:ins><w:del><w:r><w:delText>gone </w:delText></w:r></w:del></w:ins>' +
        '<w:r><w:t>B</w:t></w:r></w:p>'
    );
    expect(await textOf(bytes)).toBe('A B');
  });

  it('prefixes the document title, since filenames are often meaningless', async () => {
    const bytes = buildDocx(paragraph('Body text'), {
      'docProps/core.xml':
        '<?xml version="1.0"?><cp:coreProperties xmlns:cp="cp" xmlns:dc="dc"><dc:title>Vendor Agreement</dc:title></cp:coreProperties>',
    });
    expect(await textOf(bytes)).toBe('Vendor Agreement\n\nBody text');
  });

  it('reads footnotes, which often carry real prose', async () => {
    const bytes = buildDocx(paragraph('Main body'), {
      'word/footnotes.xml':
        '<?xml version="1.0"?><w:footnotes xmlns:w="w">' +
        paragraph('Terms apply from January.') +
        '</w:footnotes>',
    });
    expect(await textOf(bytes)).toContain('Terms apply from January.');
  });

  it('decodes entities, including numeric ones', async () => {
    const bytes = buildDocx(paragraph('Tom &amp; Jerry &#8212; friends'));
    expect(await textOf(bytes)).toBe('Tom & Jerry — friends');
  });

  it('reports a docx with no text as EMPTY rather than returning nothing', async () => {
    const result = await extractText(buildDocx('<w:p></w:p>'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('EMPTY');
  });

  it('reports an archive that is not an Office document as unsupported', async () => {
    const result = await extractText(buildZip({ 'readme.txt': 'hello' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('UNSUPPORTED_FORMAT');
  });
});
