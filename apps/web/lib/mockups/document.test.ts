/**
 * A mockup's document: each format becomes one page that needs nothing
 * from the network; a React component that does not compile — or reaches
 * for anything but React — is refused with a message the model can fix
 * it from; the host's own script rides in every one.
 */

import { MOCKUP_CSP, buildMockupDocument } from './document';
import { parseMockupRequest, type MockupRequest } from './request';

function request(overrides: Record<string, unknown>): MockupRequest {
  const parsed = parseMockupRequest({
    title: 'T',
    format: 'html',
    source: '<p>hi</p>',
    ...overrides,
  });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.request;
}

async function html(overrides: Record<string, unknown>): Promise<string> {
  const built = await buildMockupDocument(request(overrides));
  if (!built.ok) throw new Error(built.message);
  return built.html;
}

async function failure(overrides: Record<string, unknown>): Promise<string> {
  const built = await buildMockupDocument(request(overrides));
  if (built.ok) throw new Error('expected the build to fail');
  return built.message;
}

describe('the mockup CSP', () => {
  it('allows no network of any kind and sandboxes the document', () => {
    expect(MOCKUP_CSP).toContain("default-src 'none'");
    expect(MOCKUP_CSP).toContain("connect-src 'none'");
    expect(MOCKUP_CSP).toContain('img-src data: blob:');
    expect(MOCKUP_CSP).toMatch(/sandbox allow-scripts$/);
    expect(MOCKUP_CSP).not.toMatch(/https?:/);
  });
});

describe('buildMockupDocument', () => {
  it('wraps an html fragment in a page with Tailwind and the host script', async () => {
    const out = await html({ source: '<p class="p-4">hi</p>', css: '.x{color:red}' });
    expect(out).toMatch(/^<!doctype html>/);
    expect(out).toContain('<p class="p-4">hi</p>');
    expect(out).toContain('type="text/tailwindcss">.x{color:red}');
    expect(out).toContain('renkei-mockup');
    expect(out).toContain('tailwindcss');
  });

  it('puts its head first inside a whole html document, and its script last', async () => {
    const out = await html({
      source: '<!DOCTYPE html><html><head><title>Mine</title></head><body><h1>x</h1></body></html>',
    });
    expect(out.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(out.indexOf('<meta charset="utf-8">')).toBeGreaterThan(out.indexOf('<head>'));
    expect(out.indexOf('<meta charset="utf-8">')).toBeLessThan(out.indexOf('<title>Mine</title>'));
    expect(out.lastIndexOf('renkei-mockup')).toBeLessThan(out.indexOf('</body>'));
  });

  it('draws an svg without Tailwind', async () => {
    const out = await html({ format: 'svg', source: '<svg viewBox="0 0 10 10"><rect/></svg>' });
    expect(out).toContain('<svg viewBox="0 0 10 10">');
    expect(out).not.toContain('@tailwindcss/browser');
    expect(out).toContain('svg{display:block');
  });

  it('cannot be ended early by a closing script tag in its own source', async () => {
    const out = await html({ css: 'a{}</style><script>alert(1)</script>' });
    expect(out).not.toContain('</style><script>alert(1)');
  });

  it('compiles a react component into a page that mounts it', async () => {
    const out = await html({
      format: 'react',
      source:
        'import { useState } from \'react\';\nexport default function M() { const [n] = useState(3); return <div className="p-4">count {n}</div>; }',
    });
    expect(out).toContain('id="root"');
    expect(out).toContain('__mockup');
    expect(out).toContain('__RENKEI_MOCKUP__');
    // React is inlined, not fetched.
    expect(out).not.toMatch(/<script[^>]*\ssrc=/);
  });

  it('refuses a component with no default export', async () => {
    expect(await failure({ format: 'react', source: 'const A = () => <div/>;' })).toMatch(
      /export default/
    );
  });

  it('refuses a component that does not compile, with the line', async () => {
    const message = await failure({
      format: 'react',
      source: 'export default function M() {\n  return <div>;\n}',
    });
    expect(message).toMatch(/did not compile/);
    expect(message).toMatch(/line \d+:\d+/);
  });

  it.each([
    ['a package', "import x from 'lodash';\nexport default () => <div>{x}</div>;", 'lodash'],
    ['a file', "import './other.css';\nexport default () => <div/>;", './other.css'],
    [
      'a url',
      "import x from 'https://cdn.example.com/x.js';\nexport default () => <div/>;",
      'https',
    ],
  ])('refuses an import of %s', async (_name, source, mentioned) => {
    const message = await failure({ format: 'react', source });
    expect(message).toContain('only "react" is available');
    expect(message).toContain(mentioned);
  });
});
