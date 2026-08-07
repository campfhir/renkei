import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import safeFunctions from '@campfhir/safe-functions';

export default [
  {
    ignores: [
      '**/.next/**',
      '**/dist/**',
      '**/node_modules/**',
      '.claude/worktrees/**',
      '**/*.config.js',
      '**/*.config.mjs',
      'packages/db/scripts/build-migrations.js',
      'apps/web/scripts/fix-async-warnings.ts',
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
    rules: {
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
