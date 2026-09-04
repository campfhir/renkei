/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db for a tool that never touches it */
/**
 * chat_write_file's promises: the content comes back as a document the
 * runner keeps as an artifact, named as asked and typed by its extension
 * or the caller's word; a document extension is rendered from the text
 * (the renderers' own promises are in render/*.test.ts); a path, a
 * control character, a format nothing can produce or an oversized body
 * is refused with the reason.
 */

import { createLocalToolSet, type LocalToolContext } from './local-tools';
import { checkFilename, fileTools, resolveMediaType, WRITE_FILE_MAX_CHARS } from './file-tools';

const context: LocalToolContext = {
  db: null as unknown as LocalToolContext['db'],
  tenantId: 't1',
  subject: 'u1',
  chatId: 'c1',
  projectId: null,
  readOnly: false,
};

interface Doc {
  mediaType: string;
  dataBase64: string;
  title: string;
}

function isDoc(value: unknown): value is Doc {
  return (
    typeof value === 'object' &&
    value !== null &&
    'mediaType' in value &&
    'dataBase64' in value &&
    'title' in value
  );
}

function documentsOf(meta: Record<string, unknown>): Doc[] {
  const raw = meta.renkeiDocuments;
  return Array.isArray(raw) ? raw.filter(isDoc) : [];
}

describe('chat_write_file', () => {
  const tools = createLocalToolSet(fileTools());

  it('is offered under its name with filename and content required', () => {
    expect(tools.has('chat_write_file')).toBe(true);
    const def = tools.defs().find((tool) => tool.name === 'chat_write_file');
    expect(def?.inputSchema.required).toEqual(['filename', 'content']);
  });

  it('hands the content back as a document named and typed by its extension', async () => {
    const result = await tools.run(
      'chat_write_file',
      { filename: ' addresses.csv ', content: 'name,city\nAda,London\n' },
      context
    );
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toMatch(/Wrote addresses\.csv \(text\/csv, 21 bytes\)/);
    const [doc] = documentsOf(result.meta);
    expect(doc).toEqual({
      mediaType: 'text/csv',
      dataBase64: Buffer.from('name,city\nAda,London\n').toString('base64'),
      title: 'addresses.csv',
    });
  });

  it('keeps non-ASCII content byte for byte', async () => {
    const content = '# Résumé\n\n連携 — linkage\n';
    const result = await tools.run('chat_write_file', { filename: 'notes.md', content }, context);
    const [doc] = documentsOf(result.meta);
    expect(doc?.mediaType).toBe('text/markdown');
    expect(Buffer.from(doc!.dataBase64, 'base64').toString('utf8')).toBe(content);
  });

  it('takes the caller’s media type when it is a text format, and plain text when nothing says', async () => {
    const typed = await tools.run(
      'chat_write_file',
      { filename: 'data.txt', content: '{}', contentType: 'application/json; charset=utf-8' },
      context
    );
    expect(documentsOf(typed.meta)[0]?.mediaType).toBe('application/json');
    const bare = await tools.run('chat_write_file', { filename: 'README', content: 'hi' }, context);
    expect(documentsOf(bare.meta)[0]?.mediaType).toBe('text/plain');
  });

  it('renders a document format from the text and keeps it without showing it back', async () => {
    const result = await tools.run(
      'chat_write_file',
      { filename: 'report.xlsx', content: 'name,total\nAda,12\n' },
      context
    );
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toMatch(
      /Wrote report\.xlsx \(application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet, \d+ bytes\)/
    );
    const [doc] = documentsOf(result.meta);
    expect(doc?.title).toBe('report.xlsx');
    // A zip, as every Office file is.
    expect(Buffer.from(doc!.dataBase64, 'base64').subarray(0, 2).toString('latin1')).toBe('PK');
    expect(result.meta.renkeiDocumentsShown).toBe(false);
  });

  it('passes a renderer’s note on to the model', async () => {
    const result = await tools.run(
      'chat_write_file',
      { filename: 'memo.pdf', content: '# 連携\n\nLinkage.' },
      context
    );
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toMatch(/Note: The PDF fonts cover Latin text only/);
    expect(
      Buffer.from(documentsOf(result.meta)[0]!.dataBase64, 'base64').subarray(0, 4).toString()
    ).toBe('%PDF');
  });

  it('refuses a format nothing here can produce and says what to write instead', async () => {
    const result = await tools.run(
      'chat_write_file',
      { filename: 'report.xls', content: 'a,b' },
      context
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(
      /\.xls files cannot be written here: write it as \.xlsx instead/
    );
    expect(documentsOf(result.meta)).toEqual([]);
  });

  it('refuses a media type it cannot write', async () => {
    const result = await tools.run(
      'chat_write_file',
      { filename: 'x.bin', content: 'a', contentType: 'application/octet-stream' },
      context
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/application\/octet-stream is not a text format/);
  });

  it('refuses a path, a control character, an empty name and a missing body', async () => {
    for (const filename of ['../etc/passwd', 'a/b.csv', 'a\\b.csv', 'bad\nname.csv', '', '..']) {
      const result = await tools.run('chat_write_file', { filename, content: 'x' }, context);
      expect(result.isError).toBe(true);
      expect(documentsOf(result.meta)).toEqual([]);
    }
    const missing = await tools.run('chat_write_file', { filename: 'a.txt' }, context);
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toMatch(/content must be a string/);
  });

  it('refuses a body over the cap', async () => {
    const result = await tools.run(
      'chat_write_file',
      { filename: 'big.txt', content: 'x'.repeat(WRITE_FILE_MAX_CHARS + 1) },
      context
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/at most 1000000 can be written/);
  });
});

describe('checkFilename / resolveMediaType', () => {
  it('trims and bounds the name', () => {
    expect(checkFilename('  a.csv ')).toEqual({ ok: true, filename: 'a.csv' });
    expect(checkFilename('x'.repeat(256)).ok).toBe(false);
    expect(checkFilename(42).ok).toBe(false);
  });

  it('types by extension, case-insensitively, and falls back to plain text', () => {
    expect(resolveMediaType('A.JSON', undefined)).toEqual({
      ok: true,
      mediaType: 'application/json',
    });
    expect(resolveMediaType('a.tsv', undefined)).toEqual({
      ok: true,
      mediaType: 'text/tab-separated-values',
    });
    expect(resolveMediaType('a.unknown', undefined)).toEqual({ ok: true, mediaType: 'text/plain' });
    expect(resolveMediaType('a.', undefined)).toEqual({ ok: true, mediaType: 'text/plain' });
  });

  it('accepts any text/* the caller names', () => {
    expect(resolveMediaType('a.txt', 'text/x-log')).toEqual({ ok: true, mediaType: 'text/x-log' });
  });
});
