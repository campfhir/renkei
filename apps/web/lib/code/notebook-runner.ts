/**
 * Running a notebook in a checkout: the one shell command the code pane's
 * Run sends through the sandbox's exec verb, and how its answer is read.
 *
 * The command starts the checkout's Python (`.venv/bin/python` or
 * `venv/bin/python` when the repository has one, else `python3`) on the
 * runner below, which executes the notebook's code cells top to bottom
 * in the notebook's own folder and writes their outputs and execution
 * counts back into the `.ipynb` — what `jupyter nbconvert --execute
 * --inplace` does. So a run is a change to a file in the working tree,
 * uncommitted, seen by the pane, the tree's marks and the chat's tools
 * like any other; nothing rides back on the command's output but one
 * line saying how it went, which keeps the run inside the exec verb's
 * limits whatever the cells draw.
 *
 * Two engines, chosen by what the Python has installed:
 *  - `kernel` — `nbclient` with `ipykernel` (a project that depends on
 *    Jupyter): a real kernel, so magics, widgets' static output and
 *    every rich display work as they do in Jupyter.
 *  - `builtin` — nothing but the standard library: each cell `exec`ed in
 *    one shared namespace, with stdout and stderr captured, the last
 *    expression's value shown (its `_repr_html_` and friends included,
 *    so a DataFrame is a table), `display()`, matplotlib figures saved
 *    as PNG, `!command` lines run in a shell, and `%magic` lines
 *    skipped. Python notebooks only.
 * Either way a run starts from nothing (there is no kernel kept between
 * runs), every code cell's old output is cleared first, and the run
 * stops at the first cell that raises, leaving that cell's traceback as
 * its output. The built-in engine saves after every cell, so a run cut
 * short by its time limit keeps what had finished.
 *
 * The runner is compressed into the command (`python -c`), which has to
 * fit the verb's 8,000 characters: notebook-runner.test.ts holds it to
 * that and runs it for real where a `python3` is installed.
 */

import { deflateSync } from 'node:zlib';
import { isRecord } from '@renkei/guards';

/** The line of the command's output that carries the result. */
export const RESULT_MARKER = 'RENKEI_NOTEBOOK_RESULT ';

/** How long a run may take: the exec verb's own ceiling. */
export const NOTEBOOK_RUN_TIMEOUT_MS = 10 * 60_000;

export const RUNNER_SOURCE = String.raw`
import sys, os, json, io, time, ast, base64, linecache, traceback, subprocess, inspect
path = os.path.abspath(os.environ['RENKEI_NOTEBOOK_PATH'])
t0 = time.time()
real_out = sys.stdout
def done(**k):
    k['seconds'] = round(time.time() - t0, 2)
    real_out.write('\n${RESULT_MARKER}' + json.dumps(k) + '\n')
    real_out.flush()
    os._exit(0)
try:
    with open(path, encoding='utf-8') as f:
        nb = json.load(f)
    assert isinstance(nb, dict) and isinstance(nb.get('cells'), list)
except Exception as e:
    done(error='unreadable', detail=str(e)[:300])
if nb.get('nbformat', 4) < 4:
    done(error='old-format')
meta = nb.get('metadata') or {}
spec = meta.get('kernelspec') or {}
lang = (spec.get('language') or (meta.get('language_info') or {}).get('name') or 'python').lower()
code = [(i, c) for i, c in enumerate(nb['cells']) if c.get('cell_type') == 'code']
def src(c):
    s = c.get('source', '')
    return ''.join(s) if isinstance(s, list) else str(s)
def save(doc):
    tmp = path + '.run.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, path)
def summary(engine):
    failed = None
    ran = 0
    for n, (i, c) in enumerate(code):
        if c.get('execution_count') is not None:
            ran += 1
        for o in c.get('outputs') or []:
            if o.get('output_type') == 'error' and failed is None:
                failed = {'index': i, 'number': n + 1, 'ename': str(o.get('ename', '')), 'evalue': str(o.get('evalue', ''))[:300]}
    done(engine=engine, ran=ran, total=len(code), failed=failed)
for i, c in code:
    c['outputs'] = []
    c['execution_count'] = None
os.chdir(os.path.dirname(path))

def with_kernel():
    import nbformat, nbclient, ipykernel
    from jupyter_client.kernelspec import KernelSpecManager
    names = KernelSpecManager().find_kernel_specs()
    name = spec.get('name')
    if name not in names:
        if lang != 'python' or 'python3' not in names:
            return False
        name = 'python3'
    node = nbformat.reads(json.dumps(nb), as_version=4)
    client = nbclient.NotebookClient(node, timeout=None, kernel_name=name, resources={'metadata': {'path': os.getcwd()}})
    try:
        client.execute()
    except nbclient.exceptions.CellExecutionError:
        pass
    finally:
        save(node)
    nb['cells'] = node['cells']
    code[:] = [(i, c) for i, c in enumerate(nb['cells']) if c.get('cell_type') == 'code']
    return True
try:
    ok = with_kernel()
except ImportError:
    ok = False
except Exception as e:
    done(error='kernel-failed', detail=str(e)[:300])
if ok:
    summary('kernel')
if lang != 'python':
    done(error='no-kernel', language=lang)

os.environ['MPLBACKEND'] = 'Agg'
sys.path.insert(0, os.getcwd())
outputs = []
class Stream(io.TextIOBase):
    def __init__(self, name):
        self.name_ = name
    def writable(self):
        return True
    def write(self, text):
        if not isinstance(text, str):
            text = str(text)
        if text:
            if outputs and outputs[-1].get('output_type') == 'stream' and outputs[-1]['name'] == self.name_:
                outputs[-1]['text'] += text
            else:
                outputs.append({'output_type': 'stream', 'name': self.name_, 'text': text})
        return len(text)
REPRS = [('_repr_html_', 'text/html'), ('_repr_markdown_', 'text/markdown'), ('_repr_svg_', 'image/svg+xml'), ('_repr_png_', 'image/png'), ('_repr_jpeg_', 'image/jpeg'), ('_repr_latex_', 'text/latex')]
def bundle(value):
    data = {'text/plain': repr(value)}
    if inspect.isclass(value):
        return data
    for attr, mime in REPRS:
        fn = getattr(value, attr, None)
        if not callable(fn):
            continue
        try:
            got = fn()
        except Exception:
            continue
        if isinstance(got, tuple):
            got = got[0]
        if isinstance(got, (bytes, bytearray)):
            got = base64.b64encode(bytes(got)).decode('ascii')
        if isinstance(got, str) and got:
            data[mime] = got
    return data
def display(*values):
    for value in values:
        outputs.append({'output_type': 'display_data', 'data': bundle(value), 'metadata': {}})
def figures():
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is None:
        return
    for num in plt.get_fignums():
        fig = plt.figure(num)
        buf = io.BytesIO()
        fig.savefig(buf, format='png', bbox_inches='tight')
        outputs.append({'output_type': 'display_data', 'data': {'image/png': base64.b64encode(buf.getvalue()).decode('ascii'), 'text/plain': repr(fig)}, 'metadata': {}})
    plt.close('all')
def shell(command):
    got = subprocess.run(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
    sys.stdout.write(got.stdout)
def plain(text):
    lines = text.split('\n')
    if lines and lines[0].lstrip().startswith('%%'):
        head = lines[0].strip()[2:].split()
        if head and head[0] in ('bash', 'sh'):
            return '__shell__(' + repr('\n'.join(lines[1:])) + ')'
        lines[0] = ''
    for n, line in enumerate(lines):
        bare = line.lstrip()
        pad = line[:len(line) - len(bare)]
        if bare.startswith('!'):
            lines[n] = pad + '__shell__(' + repr(bare[1:]) + ')'
        elif bare.startswith('%'):
            lines[n] = pad + 'pass'
    return '\n'.join(lines)
ns = {'__name__': '__main__', 'display': display, '__shell__': shell}
count = 0
for n, (i, c) in enumerate(code):
    text = src(c)
    if not text.strip():
        continue
    count += 1
    outputs = []
    c['outputs'] = outputs
    c['execution_count'] = count
    name = '<cell %d>' % (n + 1)
    body = plain(text)
    linecache.cache[name] = (len(body), None, body.splitlines(True), name)
    sys.stdout, sys.stderr = Stream('stdout'), Stream('stderr')
    failed = False
    try:
        tree = ast.parse(body, name)
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr) and not text.rstrip().endswith(';'):
            last = ast.Expression(tree.body.pop().value)
        exec(compile(tree, name, 'exec'), ns)
        if last is not None:
            value = eval(compile(last, name, 'eval'), ns)
            if value is not None:
                ns['_'] = value
                outputs.append({'output_type': 'execute_result', 'execution_count': count, 'data': bundle(value), 'metadata': {}})
        figures()
    except BaseException as e:
        failed = True
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != name:
            tb = tb.tb_next
        if isinstance(e, SyntaxError) and tb is None:
            lines = traceback.format_exception_only(type(e), e)
        else:
            lines = traceback.format_exception(type(e), e, tb)
        outputs.append({'output_type': 'error', 'ename': type(e).__name__, 'evalue': str(e), 'traceback': [line.rstrip('\n') for line in lines]})
    finally:
        sys.stdout, sys.stderr = real_out, sys.__stderr__
    save(nb)
    if failed:
        break
save(nb)
summary('builtin')
`;

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell command that runs the notebook at `path` (relative to the
 * checkout, already validated) where it lies. It always exits 0 with a
 * result line when Python started at all; anything else is the sandbox's
 * own failure.
 */
export function notebookRunCommand(path: string): string {
  const packed = deflateSync(Buffer.from(RUNNER_SOURCE, 'utf8'), { level: 9 }).toString('base64');
  return [
    'PY=python3',
    'for p in .venv/bin/python venv/bin/python; do if [ -x "$p" ]; then PY="$PWD/$p"; break; fi; done',
    `command -v "$PY" >/dev/null 2>&1 || { echo '${RESULT_MARKER}{"error":"no-python"}'; exit 0; }`,
    `RENKEI_NOTEBOOK_PATH=${shellQuote(path)} "$PY" -c "import zlib,base64;exec(zlib.decompress(base64.b64decode('${packed}')))"`,
  ].join('\n');
}

/** How a run went, as the pane is told. */
export type NotebookRunResult =
  | {
      ok: true;
      /** A real Jupyter kernel, or the built-in cell runner. */
      engine: 'kernel' | 'builtin';
      /** Code cells that ran, the failed one included. */
      ran: number;
      /** Code cells in the notebook. */
      total: number;
      seconds: number;
      /** The cell that raised and stopped the run. */
      failed: { index: number; number: number; ename: string; evalue: string } | null;
    }
  | { ok: false; message: string };

function resultLine(stdout: string): unknown {
  const at = stdout.lastIndexOf(RESULT_MARKER);
  if (at < 0) return null;
  const line = stdout.slice(at + RESULT_MARKER.length).split('\n')[0] ?? '';
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Read the command's answer; every way it can go wrong becomes a sentence for the person. */
export function readNotebookRun(ran: {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  interrupted: boolean;
  exitCode: number | null;
}): NotebookRunResult {
  if (ran.timedOut) {
    return {
      ok: false,
      message: `The notebook was still running after ${NOTEBOOK_RUN_TIMEOUT_MS / 60_000} minutes and was stopped; cells that had finished kept their output.`,
    };
  }
  if (ran.interrupted) {
    return { ok: false, message: 'The run was stopped before it finished.' };
  }
  const value = resultLine(ran.stdout);
  if (!isRecord(value)) {
    const tail = ran.stderr.trim().split('\n').slice(-3).join('\n').slice(-400);
    return {
      ok: false,
      message: `The notebook could not be run${tail ? `: ${tail}` : ran.exitCode === null ? '.' : ` (exit ${ran.exitCode}).`}`,
    };
  }
  switch (value.error) {
    case undefined:
      break;
    case 'no-python':
      return { ok: false, message: 'There is no Python in the sandbox to run the notebook with.' };
    case 'old-format':
      return {
        ok: false,
        message: 'This notebook is in a format older than nbformat 4; convert it in Jupyter first.',
      };
    case 'no-kernel':
      return {
        ok: false,
        message: `This is a ${str(value.language) || 'non-Python'} notebook and the checkout has no Jupyter kernel for it; only Python notebooks run without one.`,
      };
    case 'kernel-failed':
      return { ok: false, message: `The Jupyter kernel could not run it: ${str(value.detail)}` };
    default:
      return {
        ok: false,
        message: `The notebook could not be read as one${str(value.detail) ? `: ${str(value.detail)}` : '.'}`,
      };
  }
  const failed = isRecord(value.failed)
    ? {
        index: num(value.failed.index),
        number: num(value.failed.number),
        ename: str(value.failed.ename),
        evalue: str(value.failed.evalue),
      }
    : null;
  return {
    ok: true,
    engine: value.engine === 'kernel' ? 'kernel' : 'builtin',
    ran: num(value.ran),
    total: num(value.total),
    seconds: num(value.seconds),
    failed,
  };
}
