import JSZip from 'jszip';
import { readUploadFiles } from './read-upload';

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('reading an import upload', () => {
  it('takes a file that is not a zip as text, under its own name', async () => {
    expect(await readUploadFiles('about-me.md', new TextEncoder().encode('- Likes tea'))).toEqual({
      ok: true,
      files: [{ name: 'about-me.md', text: '- Likes tea' }],
    });
  });

  it('calls pasted text with no name a Markdown file', async () => {
    const read = await readUploadFiles('', new TextEncoder().encode('Likes tea'));
    expect(read).toEqual({ ok: true, files: [{ name: 'pasted.md', text: 'Likes tea' }] });
  });

  it('unpacks only the JSON, Markdown and text members of a zip, skipping macOS metadata', async () => {
    const bytes = await zipOf({
      'conversations.json': '[]',
      'notes/about.md': '- x',
      'image.png': 'binary',
      'chat.html': '<html></html>',
      '__MACOSX/._conversations.json': 'junk',
    });
    const read = await readUploadFiles('export.zip', bytes);
    expect(read.ok && read.files.map((file) => file.name).sort()).toEqual([
      'conversations.json',
      'notes/about.md',
    ]);
  });

  it('refuses a zip that unpacks past the ceiling, however small it is packed', async () => {
    const bytes = await zipOf({ 'conversations.json': 'x'.repeat(200_000) });
    expect(bytes.length).toBeLessThan(10_000);
    expect(await readUploadFiles('bomb.zip', bytes, { maxUnpackedBytes: 100_000 })).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it('refuses an empty body, a broken zip, and a zip with nothing to read', async () => {
    expect(await readUploadFiles('a.md', new Uint8Array())).toEqual({ ok: false, reason: 'empty' });
    expect(await readUploadFiles('a.zip', new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    expect(await readUploadFiles('a.zip', await zipOf({ 'a.png': 'x' }))).toEqual({
      ok: false,
      reason: 'empty',
    });
  });
});
