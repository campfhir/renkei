// Run by the image build after apply-zod4.mjs: the patched server's config
// schemas must give the answers bash-language-server 5.8.1 gives on zod 3.
// Expected values were recorded from that version. A mismatch fails the build.
//
// Usage: node verify-zod4.mjs <path to bash-language-server/out>

/* global process, console */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const arg = process.argv[2];
if (!arg) throw new Error('usage: node verify-zod4.mjs <bash-language-server/out>');
const out = resolve(arg);
const require = createRequire(`${out}/`);
const config = require('./config.js');
const types = require('./shellcheck/types.js');

const failures = [];
function expect(label, actual, expected) {
  if (!isDeepStrictEqual(actual, expected)) {
    failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

const SHFMT_DEFAULTS = {
  path: 'shfmt',
  additionalArguments: [],
  ignoreEditorconfig: false,
  languageDialect: 'auto',
  binaryNextLine: false,
  caseIndent: false,
  funcNextLine: false,
  keepPadding: false,
  simplifyCode: false,
  spaceRedirects: false,
};

// Nothing supplied: every setting at its default, nested shfmt included.
const defaults = config.ConfigSchema.parse({});
expect('shfmt defaults', defaults.shfmt, SHFMT_DEFAULTS);
expect(
  'top-level defaults',
  [defaults.globPattern, defaults.shellcheckPath, defaults.backgroundAnalysisMaxFiles],
  ['**/*@(.sh|.inc|.bash|.command)', 'shellcheck', 500]
);

// Supplied values win, strings are trimmed and split.
const supplied = config.ConfigSchema.parse({
  shfmt: { additionalArguments: '-i 2  -ci', path: ' shfmt ' },
  shellcheckArguments: ' -x  -a ',
  globPattern: ' **/*.sh ',
});
expect('supplied shfmt', supplied.shfmt, {
  ...SHFMT_DEFAULTS,
  additionalArguments: ['-i', '2', '-ci'],
});
expect('supplied shellcheck arguments', supplied.shellcheckArguments, ['-x', '-a']);
expect('supplied glob', supplied.globPattern, '**/*.sh');

// Bad values are refused.
expect(
  'negative file count refused',
  config.ConfigSchema.safeParse({ backgroundAnalysisMaxFiles: -1 }).success,
  false
);
expect(
  'unknown log level refused',
  config.ConfigSchema.safeParse({ logLevel: 'nope' }).success,
  false
);

// Initialization options carry only what was supplied: no defaults.
expect('empty initialization options', config.InitializationOptionsSchema.parse({}), {});
expect(
  'partial initialization options',
  config.InitializationOptionsSchema.parse({
    backgroundAnalysisMaxFiles: 10,
    shfmt: { languageDialect: 'bash' },
  }),
  { backgroundAnalysisMaxFiles: 10, shfmt: { languageDialect: 'bash' } }
);
expect(
  'bad initialization option refused',
  config.InitializationOptionsSchema.safeParse({ logLevel: 'nope' }).success,
  false
);

// ShellCheck's JSON is parsed as before.
const comment = {
  file: 'a.sh',
  line: 1,
  endLine: 1,
  column: 1,
  endColumn: 2,
  level: 'info',
  code: 2086,
  message: 'm',
  fix: null,
};
expect(
  'shellcheck result parses',
  types.ShellCheckResultSchema.safeParse({ comments: [comment] }).success,
  true
);
expect(
  'shellcheck junk refused',
  types.ShellCheckResultSchema.safeParse({ comments: 'bad' }).success,
  false
);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('bash-language-server config schemas behave as on zod 3');
