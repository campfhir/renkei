/**
 * The command a notebook run sends through the sandbox's exec verb, how
 * its answer is read, and — where this machine has a `python3` — what
 * the command really does to a notebook.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXEC_COMMAND_MAX_CHARS, validateCommand } from '@renkei/connector-sandbox';
import { RESULT_MARKER, notebookRunCommand, readNotebookRun } from './notebook-runner';

const answered = (line: string, more: Partial<Parameters<typeof readNotebookRun>[0]> = {}) =>
  readNotebookRun({
    stdout: `noise\n${RESULT_MARKER}${line}\n`,
    stderr: '',
    timedOut: false,
    interrupted: false,
    exitCode: 0,
    ...more,
  });

describe('the command', () => {
  it('fits the exec verb’s limit with room for a long path', () => {
    const command = notebookRunCommand(`${'deep/'.repeat(100)}analysis.ipynb`);
    expect(command.length).toBeLessThan(EXEC_COMMAND_MAX_CHARS);
    expect(validateCommand(command).ok).toBe(true);
  });

  it('names the notebook quoted, so a path cannot become shell', () => {
    const command = notebookRunCommand("it's; rm -rf ~/$(x).ipynb");
    expect(command).toContain(`RENKEI_NOTEBOOK_PATH='it'\\''s; rm -rf ~/$(x).ipynb' `);
  });
});

describe('reading the answer', () => {
  it('a run of every cell', () => {
    expect(answered('{"engine":"builtin","ran":3,"total":3,"failed":null,"seconds":1.5}')).toEqual({
      ok: true,
      engine: 'builtin',
      ran: 3,
      total: 3,
      seconds: 1.5,
      failed: null,
    });
  });

  it('a cell that raised is a finished run with the cell named', () => {
    expect(
      answered(
        '{"engine":"kernel","ran":2,"total":5,"seconds":3,"failed":{"index":4,"number":2,"ename":"KeyError","evalue":"x"}}'
      )
    ).toMatchObject({
      ok: true,
      engine: 'kernel',
      failed: { index: 4, number: 2, ename: 'KeyError', evalue: 'x' },
    });
  });

  it('takes the last result line: a cell cannot print one of its own first', () => {
    const result = readNotebookRun({
      stdout: `${RESULT_MARKER}{"engine":"builtin","ran":99,"total":99,"failed":null,"seconds":0}\n${RESULT_MARKER}{"engine":"builtin","ran":1,"total":1,"failed":null,"seconds":0}\n`,
      stderr: '',
      timedOut: false,
      interrupted: false,
      exitCode: 0,
    });
    expect(result).toMatchObject({ ok: true, ran: 1 });
  });

  it.each([
    ['{"error":"no-python"}', 'There is no Python in the sandbox to run the notebook with.'],
    [
      '{"error":"old-format"}',
      'This notebook is in a format older than nbformat 4; convert it in Jupyter first.',
    ],
    [
      '{"error":"no-kernel","language":"r"}',
      'This is a r notebook and the checkout has no Jupyter kernel for it; only Python notebooks run without one.',
    ],
    [
      '{"error":"kernel-failed","detail":"Kernel died"}',
      'The Jupyter kernel could not run it: Kernel died',
    ],
    [
      '{"error":"unreadable","detail":"Expecting value"}',
      'The notebook could not be read as one: Expecting value',
    ],
  ])('%s is told as a sentence', (line, message) => {
    expect(answered(line)).toEqual({ ok: false, message });
  });

  it('a run that hit the time limit says cells that finished kept their output', () => {
    expect(answered('', { timedOut: true })).toEqual({
      ok: false,
      message:
        'The notebook was still running after 10 minutes and was stopped; cells that had finished kept their output.',
    });
  });

  it('a run the worker interrupted says so', () => {
    expect(answered('', { interrupted: true })).toEqual({
      ok: false,
      message: 'The run was stopped before it finished.',
    });
  });

  it('no result line at all shows the end of what Python said', () => {
    expect(
      readNotebookRun({
        stdout: '',
        stderr: 'Traceback…\nMemoryError',
        timedOut: false,
        interrupted: false,
        exitCode: 1,
      })
    ).toEqual({ ok: false, message: 'The notebook could not be run: Traceback…\nMemoryError' });
    expect(
      readNotebookRun({
        stdout: '',
        stderr: '',
        timedOut: false,
        interrupted: false,
        exitCode: 137,
      })
    ).toEqual({ ok: false, message: 'The notebook could not be run (exit 137).' });
  });
});

const hasPython = spawnSync('python3', ['--version']).status === 0;
const withPython = hasPython ? describe : describe.skip;

withPython('run for real, with the built-in runner', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'notebook-run-'));
    mkdirSync(join(dir, 'notebooks'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const code = (source: string, outputs: unknown[] = [], count: number | null = null) => ({
    cell_type: 'code',
    execution_count: count,
    metadata: {},
    outputs,
    source: source.split(/(?<=\n)/),
  });

  function run(cells: unknown[], metadata: unknown = {}) {
    const file = join(dir, 'notebooks', 'n.ipynb');
    writeFileSync(file, JSON.stringify({ cells, metadata, nbformat: 4, nbformat_minor: 5 }));
    const ran = spawnSync('bash', ['-c', notebookRunCommand('notebooks/n.ipynb')], {
      cwd: dir,
      encoding: 'utf8',
      // No user site packages: the built-in runner, whatever this machine has installed.
      env: { ...process.env, PYTHONNOUSERSITE: '1', HOME: dir },
    });
    const result = readNotebookRun({
      stdout: ran.stdout,
      stderr: ran.stderr,
      timedOut: false,
      interrupted: false,
      exitCode: ran.status,
    });
    const saved: {
      cells: { execution_count?: number | null; outputs?: Record<string, unknown>[] }[];
    } = JSON.parse(readFileSync(file, 'utf8'));
    return { result, cells: saved.cells };
  }

  it('runs the cells in order in one namespace and writes their outputs into the file', () => {
    const { result, cells } = run([
      { cell_type: 'markdown', metadata: {}, source: '# T' },
      code('import os\nx = 41\nprint("in", os.path.basename(os.getcwd()))\n'),
      code('x + 1', [{ output_type: 'stream', name: 'stdout', text: 'stale' }], 9),
    ]);
    if (result.ok && result.engine === 'kernel') return; // A Jupyter here: another engine's test.
    expect(result).toMatchObject({ ok: true, engine: 'builtin', ran: 2, total: 2, failed: null });
    // In the notebook's own folder, as Jupyter runs it.
    expect(cells[1]).toMatchObject({
      execution_count: 1,
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'in notebooks\n' }],
    });
    // The old output is gone; the last expression's value is the result.
    expect(cells[2]).toMatchObject({
      execution_count: 2,
      outputs: [
        { output_type: 'execute_result', execution_count: 2, data: { 'text/plain': '42' } },
      ],
    });
  });

  it('shows a value’s table, display(), stderr, shell lines, and skips magics', () => {
    const { result, cells } = run([
      code(
        [
          '%matplotlib inline',
          'import sys',
          'class Table:',
          '    def _repr_html_(self): return "<table></table>"',
          'display(Table())',
          'print("careful", file=sys.stderr)',
          '!echo from the shell',
          'Table()',
        ].join('\n')
      ),
      code('x = 1;'),
    ]);
    if (result.ok && result.engine === 'kernel') return;
    expect(result).toMatchObject({ ok: true, ran: 2, failed: null });
    const outputs = cells[0]?.outputs ?? [];
    expect(outputs.map((output) => output.output_type)).toEqual([
      'display_data',
      'stream',
      'stream',
      'execute_result',
    ]);
    expect(outputs[0]).toMatchObject({ data: { 'text/html': '<table></table>' } });
    expect(outputs[1]).toMatchObject({ name: 'stderr', text: 'careful\n' });
    expect(outputs[2]).toMatchObject({ name: 'stdout', text: 'from the shell\n' });
    expect(outputs[3]).toMatchObject({ data: { 'text/html': '<table></table>' } });
    expect(cells[1]?.outputs).toEqual([]);
  });

  it('stops at the first cell that raises, with its traceback, and leaves the rest unrun', () => {
    const { result, cells } = run([
      code('print("before")'),
      code('def f():\n    return 1/0\nf()'),
      code('print("never")', [{ output_type: 'stream', name: 'stdout', text: 'stale' }], 3),
    ]);
    if (result.ok && result.engine === 'kernel') return;
    expect(result).toMatchObject({
      ok: true,
      ran: 2,
      total: 3,
      failed: { index: 1, number: 2, ename: 'ZeroDivisionError', evalue: 'division by zero' },
    });
    const error = cells[1]?.outputs?.[0];
    expect(error).toMatchObject({ output_type: 'error', ename: 'ZeroDivisionError' });
    expect(String(error?.traceback)).toContain('File "<cell 2>", line 2, in f');
    expect(cells[2]).toMatchObject({ execution_count: null, outputs: [] });
  });

  it('a syntax error is that cell’s error, not the run’s', () => {
    const { result } = run([code('def broken(:\n    pass')]);
    if (result.ok && result.engine === 'kernel') return;
    expect(result).toMatchObject({ ok: true, failed: { number: 1, ename: 'SyntaxError' } });
  });

  it('a notebook in another language says it needs a kernel', () => {
    const { result } = run([code('x <- 1')], {
      kernelspec: { name: 'ir', language: 'R', display_name: 'R' },
    });
    expect(result).toEqual({
      ok: false,
      message:
        'This is a r notebook and the checkout has no Jupyter kernel for it; only Python notebooks run without one.',
    });
  });

  it('a file that is not a notebook is refused and left alone', () => {
    const file = join(dir, 'notebooks', 'n.ipynb');
    writeFileSync(file, '{not json');
    const ran = spawnSync('bash', ['-c', notebookRunCommand('notebooks/n.ipynb')], {
      cwd: dir,
      encoding: 'utf8',
    });
    const result = readNotebookRun({
      stdout: ran.stdout,
      stderr: ran.stderr,
      timedOut: false,
      interrupted: false,
      exitCode: ran.status,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{not json');
  });
});
