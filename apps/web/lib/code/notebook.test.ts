/**
 * How a notebook file is read for the code pane: which cells it shows,
 * what each output is drawn as, and what a file that is not a notebook
 * says.
 */

import {
  clearNotebookOutputs,
  isNotebookPath,
  parseNotebook,
  plainTerminalText,
  type NotebookCell,
} from './notebook';

function notebook(cells: unknown[], metadata: unknown = {}): string {
  return JSON.stringify({ cells, metadata, nbformat: 4, nbformat_minor: 5 });
}

function code(source: string | string[], outputs: unknown[] = [], count: number | null = 1) {
  return { cell_type: 'code', execution_count: count, metadata: {}, outputs, source };
}

function read(text: string) {
  const parsed = parseNotebook(text);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.notebook;
}

function outputsOf(cell: NotebookCell | undefined) {
  if (cell?.type !== 'code') throw new Error('not a code cell');
  return cell.outputs;
}

describe('which files are notebooks', () => {
  it('a file ending in .ipynb, whatever its case or folder', () => {
    expect(isNotebookPath('notebooks/revenue.ipynb')).toBe(true);
    expect(isNotebookPath('Analysis.IPYNB')).toBe(true);
    expect(isNotebookPath('notes.ipynb.txt')).toBe(false);
    expect(isNotebookPath('script.py')).toBe(false);
  });
});

describe('the cells', () => {
  it('come in the file’s order, code cells numbered among themselves', () => {
    const result = read(
      notebook([
        { cell_type: 'markdown', metadata: {}, source: ['# Title\n', 'text'] },
        code('a = 1'),
        { cell_type: 'raw', metadata: {}, source: 'raw text' },
        code(['b = 2\n', 'b'], [], null),
      ])
    );
    expect(result.cells.map((cell) => cell.type)).toEqual(['markdown', 'code', 'raw', 'code']);
    expect(result.cells[0]).toMatchObject({ source: '# Title\ntext' });
    expect(result.cells[1]).toMatchObject({ index: 1, number: 1, executionCount: 1 });
    expect(result.cells[3]).toMatchObject({
      index: 3,
      number: 2,
      executionCount: null,
      source: 'b = 2\nb',
    });
    expect(result.codeCells).toBe(2);
  });

  it('the language and kernel are the notebook’s own, Python when it does not say', () => {
    expect(read(notebook([])).language).toBe('python');
    expect(read(notebook([])).kernelName).toBeNull();
    const r = read(
      notebook([], { kernelspec: { display_name: 'R 4.3', language: 'R', name: 'ir' } })
    );
    expect(r).toMatchObject({ language: 'r', kernelName: 'R 4.3' });
    expect(read(notebook([], { language_info: { name: 'julia' } })).language).toBe('julia');
  });

  it('counts the code cells that carry output, for Clear outputs', () => {
    const result = read(
      notebook([
        code('print(1)', [{ output_type: 'stream', name: 'stdout', text: '1\n' }]),
        code('x = 1'),
      ])
    );
    expect(result.withOutput).toBe(1);
  });
});

describe('a cell’s outputs', () => {
  it('printed text is a stream, consecutive writes to one stream joined', () => {
    const result = read(
      notebook([
        code('…', [
          { output_type: 'stream', name: 'stdout', text: ['a\n', 'b\n'] },
          { output_type: 'stream', name: 'stdout', text: 'c\n' },
          { output_type: 'stream', name: 'stderr', text: 'warning\n' },
        ]),
      ])
    );
    expect(outputsOf(result.cells[0])).toEqual([
      { kind: 'stream', name: 'stdout', text: 'a\nb\nc\n' },
      { kind: 'stream', name: 'stderr', text: 'warning\n' },
    ]);
  });

  it('a value with a table shows the table, not its plain text', () => {
    const result = read(
      notebook([
        code('df', [
          {
            output_type: 'execute_result',
            execution_count: 1,
            metadata: {},
            data: { 'text/plain': 'a  b', 'text/html': ['<table>', '</table>'] },
          },
        ]),
      ])
    );
    expect(outputsOf(result.cells[0])).toEqual([{ kind: 'html', html: '<table></table>' }]);
  });

  it('a figure is an image, ahead of every other form it came with', () => {
    const result = read(
      notebook([
        code('plt.plot()', [
          {
            output_type: 'display_data',
            metadata: {},
            data: {
              'text/plain': '<Figure>',
              'text/html': '<b>x</b>',
              'image/png': 'iVBORw0KGgo=\n',
            },
          },
        ]),
      ])
    );
    expect(outputsOf(result.cells[0])).toEqual([
      { kind: 'image', mime: 'image/png', src: 'data:image/png;base64,iVBORw0KGgo=' },
    ]);
  });

  it('an SVG is drawn as an image, its markup never put in the page', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const result = read(
      notebook([code('fig', [{ output_type: 'display_data', data: { 'image/svg+xml': svg } }])])
    );
    const [output] = outputsOf(result.cells[0]);
    expect(output).toMatchObject({ kind: 'image', mime: 'image/svg+xml' });
    expect(output?.kind === 'image' && output.src).toBe(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    );
  });

  it('image data that is not base64 is not made into an address', () => {
    const result = read(
      notebook([
        code('x', [
          {
            output_type: 'display_data',
            data: { 'image/png': 'x" onerror="alert(1)', 'text/plain': 'fallback' },
          },
        ]),
      ])
    );
    expect(outputsOf(result.cells[0])).toEqual([{ kind: 'text', text: 'fallback' }]);
  });

  it('a form the pane cannot draw falls back to the output’s plain text', () => {
    const result = read(
      notebook([
        code('w', [
          {
            output_type: 'display_data',
            data: {
              'application/vnd.jupyter.widget-view+json': { model_id: 'abc' },
              'text/plain': 'IntSlider(value=3)',
            },
          },
        ]),
      ])
    );
    expect(outputsOf(result.cells[0])).toEqual([{ kind: 'text', text: 'IntSlider(value=3)' }]);
  });

  it('an error shows its traceback without the terminal’s colour codes', () => {
    const result = read(
      notebook([
        code('1/0', [
          {
            output_type: 'error',
            ename: 'ZeroDivisionError',
            evalue: 'division by zero',
            traceback: ['\u001b[0;31mZeroDivisionError\u001b[0m: division by zero'],
          },
        ]),
      ])
    );
    expect(outputsOf(result.cells[0])).toEqual([
      {
        kind: 'error',
        ename: 'ZeroDivisionError',
        evalue: 'division by zero',
        traceback: 'ZeroDivisionError: division by zero',
      },
    ]);
  });

  it('a progress bar that rewrote its line shows only what was left on it', () => {
    expect(plainTerminalText('10%\r50%\r100%\ndone')).toBe('100%\ndone');
  });
});

describe('a file that is not a notebook', () => {
  it.each([
    ['', 'This notebook is empty.'],
    ['{not json', 'This file is not valid JSON, so it cannot be shown as a notebook.'],
    ['[1, 2]', 'This file does not hold a notebook.'],
    ['{"metadata": {}}', 'This file does not hold a notebook’s cells.'],
    [
      '{"nbformat": 3, "worksheets": []}',
      'This notebook is in a format older than nbformat 4; convert it in Jupyter to see it here.',
    ],
  ])('%j says why', (text, message) => {
    expect(parseNotebook(text)).toEqual({ ok: false, message });
  });
});

describe('Clear outputs', () => {
  it('takes every code cell’s outputs and count out and leaves the rest as it was', () => {
    const text = notebook(
      [
        { cell_type: 'markdown', metadata: {}, source: '# T' },
        code('print(1)', [{ output_type: 'stream', name: 'stdout', text: '1\n' }], 4),
      ],
      { kernelspec: { name: 'python3' } }
    );
    const cleared = clearNotebookOutputs(text);
    expect(cleared?.endsWith('\n')).toBe(true);
    const value = JSON.parse(cleared ?? '');
    expect(value.cells[0]).toEqual({ cell_type: 'markdown', metadata: {}, source: '# T' });
    expect(value.cells[1]).toMatchObject({
      outputs: [],
      execution_count: null,
      source: 'print(1)',
    });
    expect(value.metadata).toEqual({ kernelspec: { name: 'python3' } });
    expect(read(cleared ?? '').withOutput).toBe(0);
  });

  it('has nothing to do with a file that is not a notebook', () => {
    expect(clearNotebookOutputs('{not json')).toBeNull();
    expect(clearNotebookOutputs('{"a": 1}')).toBeNull();
  });
});
