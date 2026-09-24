export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    // The real logger imports the bored-logs Postgres adapter, which reaches
    // ESM-only kysely helpers jest cannot parse; tests get a silent logger.
    // Nothing under test imports @renkei/worker-kit/logger directly (only
    // this worker's own ./logger.ts does, and that's what's mapped below),
    // so there is no matching entry for it here — add one, pointed at this
    // same mock, if that ever changes.
    '^\\.\\./logger$': '<rootDir>/src/test-support/logger-mock.ts',
    '^\\./logger$': '<rootDir>/src/test-support/logger-mock.ts',
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
    '^@renkei/settings$': '<rootDir>/../../packages/settings/src/index.ts',
    '^@renkei/connector-admanager$': '<rootDir>/../../packages/connector-admanager/src/index.ts',
    '^@renkei/worker-kit$': '<rootDir>/../../packages/worker-kit/src/index.ts',
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
