/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db for a tool that never touches it */
/**
 * chat_write_chart's promises: the worker's render comes back as a
 * document the runner keeps as an artifact, named as asked with the
 * format's own extension and typed by the worker's answer, kept without
 * being read back; a bad option, a path, or an empty diagram is refused
 * before the worker is asked; a worker refusal (Mermaid's parse error
 * among them) is the error the model sees.
 */

jest.mock('@renkei/sandbox-client', () => ({
  sbChartRender: jest.fn(),
  clientFailure: jest.fn((error: { kind: string; type?: string; message?: string }) => ({
    status: 400,
    message: error.message ?? `failed: ${error.type ?? error.kind}`,
  })),
}));

import { createLocalToolSet, type LocalToolContext } from './local-tools';
import { chartTools } from './chart-tools';

const client = jest.requireMock<{ sbChartRender: jest.Mock }>('@renkei/sandbox-client');

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

const SOURCE = 'pie title Tickets\n  "Open" : 42\n  "Closed" : 58';
const RENDERED = {
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  mediaType: 'image/png',
  width: 597,
  height: 482,
  diagramType: 'pie',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('chat_write_chart', () => {
  const tools = createLocalToolSet(chartTools());

  it('is offered under its name with the source required, and explains Mermaid text', () => {
    expect(tools.has('chat_write_chart')).toBe(true);
    const def = tools.defs().find((tool) => tool.name === 'chat_write_chart');
    expect(def?.inputSchema.required).toEqual(['source']);
    expect(def?.description).toMatch(/xychart-beta/);
    expect(def?.description).toMatch(/gantt/);
  });

  it('hands the render back as a document named for the format, kept without being read back', async () => {
    client.sbChartRender.mockResolvedValue({ ok: true, val: RENDERED });
    const result = await tools.run(
      'chat_write_chart',
      { source: SOURCE, filename: ' tickets ' },
      context
    );
    expect(result.isError).toBe(false);
    expect(client.sbChartRender).toHaveBeenCalledWith(
      { tenantId: 't1', subject: 'u1' },
      { source: SOURCE, format: 'png', theme: 'default', background: '#ffffff', scale: 2 }
    );
    expect(result.content[0]?.text).toMatch(
      /Drew tickets\.png \(image\/png, 4 bytes, 597×482 px, a pie diagram\)/
    );
    expect(result.content[0]?.text).toMatch(/Artifacts/);
    const docs = documentsOf(result.meta);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toEqual({
      mediaType: 'image/png',
      dataBase64: Buffer.from(RENDERED.bytes).toString('base64'),
      title: 'tickets.png',
    });
    expect(result.meta.renkeiDocumentsShown).toBe(false);
  });

  it('carries every option through, correcting the extension and painting a PDF', async () => {
    client.sbChartRender.mockResolvedValue({
      ok: true,
      val: { ...RENDERED, mediaType: 'application/pdf' },
    });
    const result = await tools.run(
      'chat_write_chart',
      {
        source: SOURCE,
        filename: 'tickets.png',
        format: 'pdf',
        theme: 'forest',
        background: 'transparent',
        scale: 1,
      },
      context
    );
    expect(result.isError).toBe(false);
    expect(client.sbChartRender.mock.calls[0]?.[1]).toEqual({
      source: SOURCE,
      format: 'pdf',
      theme: 'forest',
      background: '#ffffff',
      scale: 1,
    });
    expect(documentsOf(result.meta)[0]?.title).toBe('tickets.pdf');
  });

  it('refuses a bad option, a path or an empty diagram before asking the worker', async () => {
    const empty = await tools.run('chat_write_chart', { source: '' }, context);
    expect(empty.isError).toBe(true);
    expect(empty.content[0]?.text).toMatch(/source must be the Mermaid diagram text/);
    const scale = await tools.run('chat_write_chart', { source: SOURCE, scale: 9 }, context);
    expect(scale.isError).toBe(true);
    expect(scale.content[0]?.text).toMatch(/scale must be a whole number/);
    const path = await tools.run('chat_write_chart', { source: SOURCE, filename: 'a/b' }, context);
    expect(path.isError).toBe(true);
    expect(path.content[0]?.text).toMatch(/not a path/);
    expect(client.sbChartRender).not.toHaveBeenCalled();
  });

  it('reports the worker’s refusal as the error', async () => {
    client.sbChartRender.mockResolvedValue({
      ok: false,
      err: {
        kind: 'op',
        type: 'invalid_diagram',
        message: 'Mermaid could not draw this diagram: Parse error on line 3',
      },
    });
    const result = await tools.run(
      'chat_write_chart',
      { source: 'flowchart LR\n  A --> ' },
      context
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Parse error on line 3/);
    expect(documentsOf(result.meta)).toHaveLength(0);
  });
});
