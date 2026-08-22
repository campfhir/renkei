export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  // The expired-grants sweep test hits a real database through kysely,
  // whose published build is ESM-only — transformed here the same way the
  // sibling worker-agents config does (ts-jest with allowJs turns it into
  // CJS for the run). Suites that mock kysely are unaffected.
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
  moduleNameMapper: {
    // The real logger imports the bored-logs Postgres adapter, which reaches
    // ESM-only kysely helpers jest cannot parse; tests get a silent logger.
    '^\\.\\./logger$': '<rootDir>/src/test-support/logger-mock.ts',
    '^\\./logger$': '<rootDir>/src/test-support/logger-mock.ts',
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/worker-loop$': '<rootDir>/../../packages/worker-loop/src/index.ts',
    '^@renkei/agents$': '<rootDir>/../../packages/agents/src/index.ts',
    '^@renkei/agents/runs$': '<rootDir>/../../packages/agents/src/runs.ts',
    '^@renkei/agents/event-fanout$': '<rootDir>/../../packages/agents/src/event-fanout.ts',
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
    '^@renkei/document-text$': '<rootDir>/../../packages/document-text/src/index.ts',
    '^@renkei/email-sanitizer$': '<rootDir>/../../packages/email-sanitizer/src/index.ts',
    '^@renkei/connector-config$': '<rootDir>/../../packages/connector-config/src/index.ts',
    '^@renkei/connector-atlassian$': '<rootDir>/../../packages/connector-atlassian/src/index.ts',
    '^@renkei/connector-webex$': '<rootDir>/../../packages/connector-webex/src/index.ts',
    '^@renkei/gates$': '<rootDir>/../../packages/gates/src/index.ts',
    '^@renkei/knowledge$': '<rootDir>/../../packages/knowledge/src/index.ts',
    '^@renkei/queue$': '<rootDir>/../../packages/queue/src/index.ts',
    '^@renkei/settings$': '<rootDir>/../../packages/settings/src/index.ts',
  },
};
