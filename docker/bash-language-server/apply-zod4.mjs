// bash-language-server 5.8.1 pins zod 3.25.76, which has an open HIGH advisory
// (CVE-2023-54404) fixed only in zod 4. The package.json beside this file
// overrides zod to 4.6.6; this script makes the two schemas in the server's
// config.js behave under zod 4 as they do under zod 3 (checked by
// verify-zod4.mjs, which the image build runs next). Every edit is an exact
// string replacement that must match once: a different bash-language-server
// release fails the build here, loudly, rather than shipping a changed config.
//
// 1. `ShfmtConfigSchema.default({})` — zod 4's .default() returns its value
//    without parsing it, so the nested shfmt settings lost their own defaults.
//    `.prefault({})` is zod 4's name for the old behavior.
// 2. `ConfigSchema.partial()` — zod 4 applies a field's default inside
//    .optional(), so initialization options (meant to override only what the
//    editor supplied, keeping the environment's defaults) would overwrite
//    every setting with the built-in default. The schema is rebuilt from the
//    fields with their defaults removed.
//
// Usage: node apply-zod4.mjs <path to bash-language-server/out/config.js>

/* global process */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('usage: node apply-zod4.mjs <config.js>');

let source = readFileSync(file, 'utf8');

function replaceOnce(from, to) {
  const first = source.indexOf(from);
  if (first === -1 || source.indexOf(from, first + 1) !== -1) {
    throw new Error(
      `${file}: expected exactly one occurrence of ${JSON.stringify(from.slice(0, 70))}; ` +
        'this bash-language-server release changed, so the zod 4 patch needs revisiting.'
    );
  }
  source = source.replace(from, () => to);
}

replaceOnce(
  'shfmt: exports.ShfmtConfigSchema.default({}),',
  'shfmt: exports.ShfmtConfigSchema.prefault({}),'
);

replaceOnce(
  `exports.InitializationOptionsSchema = exports.ConfigSchema.partial().extend({
    shfmt: exports.ShfmtConfigSchema.partial().optional(),
});`,
  `const withoutDefaults = (shape) => zod_1.z.object(Object.fromEntries(Object.entries(shape).map(([key, field]) => [
    key,
    (typeof field.removeDefault === 'function' ? field.removeDefault() : field).optional(),
])));
exports.InitializationOptionsSchema = withoutDefaults({
    ...exports.ConfigSchema.shape,
    shfmt: withoutDefaults(exports.ShfmtConfigSchema.shape).optional(),
});`
);

writeFileSync(file, source);
