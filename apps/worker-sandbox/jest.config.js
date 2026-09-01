export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    // The real logger imports the bored-logs Postgres adapter, which reaches
    // ESM-only kysely helpers jest cannot parse; tests get a silent logger.
    '^\\.\\./logger$': '<rootDir>/src/test-support/logger-mock.ts',
    '^\\./logger$': '<rootDir>/src/test-support/logger-mock.ts',
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
    '^@renkei/settings$': '<rootDir>/../../packages/settings/src/index.ts',
    '^@renkei/connector-sandbox$': '<rootDir>/../../packages/connector-sandbox/src/index.ts',
  },
  // kysely's published build is ESM-only; ts-jest (allowJs) transforms it to
  // CJS for the test run — the worker-agents arrangement.
  transformIgnorePatterns: ['/node_modules/(?!.*kysely)'],
  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        tsconfig: {
          esModuleInterop: true,
          allowJs: true,
        },
      },
    ],
  },
};
