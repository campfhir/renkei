/**
 * The process a notebook kernel session runs (kernel-sessions.ts): a
 * Python that stays up between cells, so what one cell defines the next
 * can use.
 *
 * `KERNEL_LAUNCH` is the shell that picks the Python and starts the host
 * on it, as the checkout's own uid in the checkout:
 *  - the repository's own environment when it has one (`.venv/bin/python`
 *    or `venv/bin/python`), so a notebook sees what the project installs;
 *  - otherwise a notebook environment of the caller's own, made once
 *    under their home (`~/.renkei/notebook-env`, a venv over the system
 *    Python) — a place `%pip install` can write to, kept from one kernel
 *    to the next. Where the worker has its packaged Python
 *    (`RENKEI_SANDBOX_PYTHON`: pandas, numpy, matplotlib and the rest of
 *    the sandbox image's set) of the same version, that environment's
 *    packages are put on the new one's path behind its own, so they
 *    import without installing and anything installed here wins;
 *  - failing a venv, the system `python3` as it is.
 *
 * `KERNEL_HOST_SOURCE` is the host: it speaks one JSON object per line.
 * It says `{"ready": true, "engine", "python"}` once, then answers each
 * `{"id", "code"}` on its stdin with `{"id", "outputs", "execution_count",
 * "ok"}` — `outputs` in nbformat's own shapes, so the page stores them
 * in the notebook as they are. The protocol has a descriptor of its
 * own: the process's stdout is pointed at its stderr before any cell
 * runs, so nothing a cell or a library prints can be mistaken for it.
 *
 * Two engines, by what the chosen Python has:
 *  - `kernel` — `ipykernel` and `jupyter_client` are installed: a real
 *    Jupyter kernel is started and the host relays to it, so magics and
 *    every rich display behave as in Jupyter.
 *  - `builtin` — the standard library alone: each cell `exec`ed in one
 *    namespace kept for the session's life, stdout and stderr captured,
 *    the last expression's value shown with its rich forms (a DataFrame
 *    is a table), `display()`, matplotlib figures as PNG, `!command`
 *    lines in a shell, `%pip` (and `!pip`) run on this Python so an
 *    install lands where the kernel imports from, `%time`-style magics
 *    reduced to their statement and the rest skipped.
 * SIGINT interrupts the running cell (KeyboardInterrupt, as the cell's
 * error) and leaves the session up; end of input ends it.
 */

/** A cell's printed text past this many characters is cut, with a line saying so. */
export const KERNEL_STREAM_MAX_CHARS = 400_000;

export const KERNEL_HOST_SOURCE = String.raw`
import sys, os, json, io, ast, base64, linecache, traceback, subprocess, inspect, signal, shlex, importlib, platform
proto = os.fdopen(os.dup(1), 'w', encoding='utf-8')
os.dup2(2, 1)
def send(obj):
    proto.write(json.dumps(obj) + '\n')
    proto.flush()
LIMIT = ${KERNEL_STREAM_MAX_CHARS}
os.chdir(sys.argv[1])

def stream_to(outputs, name, text):
    if not text:
        return
    size = sum(len(o['text']) for o in outputs if o.get('output_type') == 'stream')
    if size >= LIMIT:
        return
    if size + len(text) > LIMIT:
        text = text[:LIMIT - size] + '\n[output cut: more than %d characters were printed]\n' % LIMIT
    if outputs and outputs[-1].get('output_type') == 'stream' and outputs[-1]['name'] == name:
        outputs[-1]['text'] += text
    else:
        outputs.append({'output_type': 'stream', 'name': name, 'text': text})

def jupyter():
    from jupyter_client.manager import KernelManager
    import ipykernel
    km = KernelManager(kernel_name='python3')
    km.start_kernel(cwd=os.getcwd())
    kc = km.blocking_client()
    kc.start_channels()
    kc.wait_for_ready(timeout=60)
    signal.signal(signal.SIGINT, lambda *a: km.interrupt_kernel())
    def run(code):
        outputs = []
        def hook(msg):
            kind = msg['header']['msg_type']
            c = msg['content']
            if kind == 'stream':
                stream_to(outputs, c.get('name', 'stdout'), c.get('text', ''))
            elif kind in ('display_data', 'execute_result'):
                out = {'output_type': kind, 'data': c.get('data', {}), 'metadata': c.get('metadata', {})}
                if kind == 'execute_result':
                    out['execution_count'] = c.get('execution_count')
                outputs.append(out)
            elif kind == 'error':
                outputs.append({'output_type': 'error', 'ename': c.get('ename', ''), 'evalue': c.get('evalue', ''), 'traceback': c.get('traceback', [])})
            elif kind == 'clear_output':
                del outputs[:]
        reply = kc.execute_interactive(code, output_hook=hook, allow_stdin=False, stop_on_error=True)
        content = reply.get('content', {})
        return outputs, content.get('execution_count'), content.get('status') == 'ok'
    def stop():
        try:
            kc.stop_channels()
            km.shutdown_kernel(now=True)
        except Exception:
            pass
    return run, stop

def builtin():
    os.environ['MPLBACKEND'] = 'Agg'
    sys.path.insert(0, os.getcwd())
    state = {'count': 0, 'outputs': []}
    class Stream(io.TextIOBase):
        def __init__(self, name):
            self.name_ = name
        def writable(self):
            return True
        def write(self, text):
            if not isinstance(text, str):
                text = str(text)
            stream_to(state['outputs'], self.name_, text)
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
            state['outputs'].append({'output_type': 'display_data', 'data': bundle(value), 'metadata': {}})
    def figures():
        plt = sys.modules.get('matplotlib.pyplot')
        if plt is None:
            return
        for num in plt.get_fignums():
            fig = plt.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format='png', bbox_inches='tight')
            state['outputs'].append({'output_type': 'display_data', 'data': {'image/png': base64.b64encode(buf.getvalue()).decode('ascii'), 'text/plain': repr(fig)}, 'metadata': {}})
        plt.close('all')
    def shell(command):
        got = subprocess.run(command, shell=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
        sys.stdout.write(got.stdout)
    def pip(args):
        got = subprocess.run([sys.executable, '-m', 'pip', '--disable-pip-version-check'] + shlex.split(args), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
        sys.stdout.write(got.stdout)
        importlib.invalidate_caches()
        if got.returncode != 0:
            raise RuntimeError('pip exited with status %d' % got.returncode)
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
            word = bare.split(' ', 1)
            rest = word[1] if len(word) > 1 else ''
            if word[0] in ('%pip', '!pip', '!pip3'):
                lines[n] = pad + '__pip__(' + repr(rest) + ')'
            elif bare.startswith('!'):
                lines[n] = pad + '__shell__(' + repr(bare[1:]) + ')'
            elif word[0] in ('%time', '%timeit') and rest.strip():
                lines[n] = pad + rest
            elif bare.startswith('%'):
                lines[n] = pad + 'pass'
        return '\n'.join(lines)
    ns = {'__name__': '__main__', 'display': display, '__shell__': shell, '__pip__': pip}
    def run(text):
        state['count'] += 1
        count = state['count']
        outputs = state['outputs'] = []
        name = '<cell %d>' % count
        body = plain(text)
        linecache.cache[name] = (len(body), None, body.splitlines(True), name)
        out, err = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = Stream('stdout'), Stream('stderr')
        ok = True
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
            ok = False
            tb = e.__traceback__
            while tb is not None and tb.tb_frame.f_code.co_filename != name:
                tb = tb.tb_next
            if tb is None:
                lines = traceback.format_exception_only(type(e), e)
            else:
                lines = traceback.format_exception(type(e), e, tb)
            outputs.append({'output_type': 'error', 'ename': type(e).__name__, 'evalue': str(e), 'traceback': [line.rstrip('\n') for line in lines]})
        finally:
            sys.stdout, sys.stderr = out, err
        return outputs, count, ok
    return run, lambda: None

try:
    run, stop = jupyter()
    engine = 'kernel'
except ImportError:
    run, stop = builtin()
    engine = 'builtin'
except Exception as e:
    sys.stderr.write('The Jupyter kernel would not start (%s); using the built-in runner.\n' % e)
    run, stop = builtin()
    engine = 'builtin'
signal.signal(signal.SIGTERM, lambda *a: (stop(), os._exit(0)))
send({'ready': True, 'engine': engine, 'python': platform.python_version()})
while True:
    try:
        line = sys.stdin.readline()
    except KeyboardInterrupt:
        continue
    if not line:
        break
    try:
        request = json.loads(line)
        ident, code = request['id'], str(request['code'])
    except Exception:
        continue
    try:
        outputs, count, ok = run(code)
    except KeyboardInterrupt:
        outputs, count, ok = [{'output_type': 'error', 'ename': 'KeyboardInterrupt', 'evalue': '', 'traceback': ['KeyboardInterrupt']}], None, False
    try:
        send({'id': ident, 'outputs': outputs, 'execution_count': count, 'ok': ok})
    except (TypeError, ValueError) as e:
        send({'id': ident, 'outputs': [{'output_type': 'error', 'ename': 'OutputError', 'evalue': str(e), 'traceback': ['The cell ran, but its output could not be sent: %s' % e]}], 'execution_count': count, 'ok': False})
stop()
`;

/**
 * The shell that chooses the Python and becomes the host. `$1` is the
 * host's source, `$2` the notebook's folder. When no Python can be found
 * it says so in the protocol's own words and exits.
 */
export const KERNEL_LAUNCH = String.raw`mkdir -p "$TMPDIR" 2>/dev/null
PY=""
for p in .venv/bin/python venv/bin/python; do
  if [ -x "$p" ]; then PY="$PWD/$p"; break; fi
done
if [ -z "$PY" ]; then
  V="$HOME/.renkei/notebook-env"
  if [ ! -x "$V/bin/python" ] && command -v python3 >/dev/null 2>&1; then
    mkdir -p "$HOME/.renkei" 2>/dev/null
    if python3 -m venv --system-site-packages "$V" >&2; then
      if [ -n "$RENKEI_SANDBOX_PYTHON" ] && [ -x "$RENKEI_SANDBOX_PYTHON" ]; then
        "$V/bin/python" -c '
import os, site, subprocess, sys
probe = "import sys, site; print(sys.version_info[0], sys.version_info[1]); print(site.getsitepackages()[0])"
got = subprocess.run([os.environ["RENKEI_SANDBOX_PYTHON"], "-c", probe], capture_output=True, text=True).stdout.splitlines()
if len(got) == 2 and got[0] == "%d %d" % sys.version_info[:2]:
    with open(os.path.join(site.getsitepackages()[0], "renkei-sandbox.pth"), "w") as f:
        f.write(got[1] + "\n")
' >&2 || true
      fi
    else
      rm -rf "$V"
    fi
  fi
  if [ -x "$V/bin/python" ]; then PY="$V/bin/python"; else PY="$(command -v python3 || true)"; fi
fi
if [ -z "$PY" ]; then
  echo '{"ready": false, "error": "no-python"}'
  exit 0
fi
exec "$PY" -u -c "$1" "$2"
`;
