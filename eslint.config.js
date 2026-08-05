import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import safeFunctions from '@campfhir/safe-functions';

export default [
  {
    ignores: [
      '.next/**',
      'dist/**',
      'node_modules/**',
      '*.config.js',
      '*.config.mjs',
      'scripts/build-migrations.js',
      'postcss.config.mjs',
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
      'lib/migrations/**/*.ts',
      'lib/mcp-tools/**/*.ts',
      'lib/mcp-tools/**/*.tsx',
      'app/api/**/*.ts',
      'app/**/*page.tsx',
      'app/**/*layout.tsx',
      'app/tenant/**/*.tsx',
      'lib/auth-utils.ts',
      'lib/db.ts',
      'lib/logging/bored-logger.ts',
      'lib/util/retry.ts',
      'lib/ui/**/*.tsx',
    ],
    rules: {
      'result/no-unwrapped-async': 'off',
    },
  },
  {
    files: ['lib/mcp-tools/**/*.ts', 'lib/mcp-tools/**/*.tsx'],
    rules: {
      'result/no-throw': 'off',
    },
  },
];
