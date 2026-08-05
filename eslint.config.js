import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import safeFunctions from '@campfhir/safe-functions';

export default [
  {
    ignores: ['.next/**', 'dist/**', 'node_modules/**', '*.config.js', 'scripts/build-migrations.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  safeFunctions.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: true,
      },
    },
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
];
