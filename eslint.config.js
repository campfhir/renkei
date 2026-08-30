import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import safeFunctions from '@campfhir/safe-functions';
import logTemplateFields from './scripts/eslint-rules/log-template-fields.js';

export default [
  {
    ignores: [
      '**/.next/**',
      '**/dist/**',
      '**/node_modules/**',
      '.claude/worktrees/**',
      '**/*.config.js',
      '**/*.config.mjs',
      // Cleaner-library scripts are pasteable payloads, not module code:
      // nothing imports them, so the exported function is "unused" by
      // definition, and their exact text is what an admin copies into the
      // editor. Correctness is enforced by `verify:cleaners`, which runs
      // each one in the real sandbox against recorded cases.
      //
      // Numbered, so this covers the payloads and NOT cleaner-globals.d.ts
      // beside them, which is ordinary source and wants ordinary linting.
      'packages/email-sanitizer/scripts/cleaner-library/[0-9]*.ts',
      'packages/db/scripts/build-migrations.js',
      'apps/web/scripts/fix-async-warnings.ts',
      'apps/web/scripts/generate-log-ship-keys.mjs',
      // Standalone widget-bundle build script, same category.
      'apps/web/lib/mcp-widgets/build.mjs',
      // Plain Node CJS jest setupFiles entry — no tsconfig project covers it,
      // same category as the standalone scripts above.
      'apps/web/jest.env-integration.js',
      // Service worker: runs in its own global scope (`self`, `clients`),
      // served as-is from public/, outside every tsconfig project — same
      // category as the standalone scripts above.
      'apps/web/public/sw.js',
      // Standalone vendoring script: runs via tsx, no tsconfig project covers it.
      'scripts/trim-graph-openapi.ts',
      // The local ESLint rules themselves — plain ESM consumed by this config,
      // outside every tsconfig project, same category as the scripts above.
      'scripts/eslint-rules/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: true,
      },
    },
    ...safeFunctions.configs.recommended,
    plugins: {
      ...safeFunctions.configs.recommended.plugins,
      // Local rules live in scripts/eslint-rules. See that file for why a
      // type cannot catch what this one catches.
      renkei: { rules: { 'log-template-fields': logTemplateFields } },
    },
    rules: {
      // `application`, `version` and `commit` are handed to createLogger as
      // global attributes in each app's logger.ts, so they resolve on every
      // record without a call site repeating them.
      'renkei/log-template-fields': [
        'error',
        { globalAttributes: ['application', 'version', 'commit'] },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        {
          assertionStyle: 'never',
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: [
      'packages/db/src/**/*.ts',
      'apps/web/lib/mcp-tools/**/*.ts',
      'apps/web/lib/mcp-tools/**/*.tsx',
      'apps/web/app/api/**/*.ts',
      'apps/web/app/**/*page.tsx',
      'apps/web/app/**/*layout.tsx',
      'apps/web/app/tenant/**/*.tsx',
      'apps/web/lib/auth-utils.ts',
      'apps/web/lib/actionable-items.ts',
      'apps/web/lib/logging/bored-logger.ts',
      'apps/web/lib/util/retry.ts',
      'apps/web/lib/ui/**/*.tsx',
    ],
    rules: {
      'result/no-unwrapped-async': 'off',
    },
  },
  {
    files: ['apps/web/lib/mcp-tools/**/*.ts', 'apps/web/lib/mcp-tools/**/*.tsx'],
    rules: {
      'result/no-throw': 'off',
    },
  },
];
