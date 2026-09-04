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
    '^@renkei/connector-config$': '<rootDir>/../../packages/connector-config/src/index.ts',
    '^@renkei/queue$': '<rootDir>/../../packages/queue/src/index.ts',
    '^@renkei/settings$': '<rootDir>/../../packages/settings/src/index.ts',
    '^@renkei/agents$': '<rootDir>/../../packages/agents/src/index.ts',
    '^@renkei/agents/step-prompts$': '<rootDir>/../../packages/agents/src/step-prompts.ts',
    '^@renkei/agents/runs$': '<rootDir>/../../packages/agents/src/runs.ts',
    '^@renkei/agents/event-fanout$': '<rootDir>/../../packages/agents/src/event-fanout.ts',
    '^@renkei/agent-llm$': '<rootDir>/../../packages/agent-llm/src/index.ts',
    '^@renkei/worker-loop$': '<rootDir>/../../packages/worker-loop/src/index.ts',
    '^@renkei/mcp-client$': '<rootDir>/../../packages/mcp-client/src/index.ts',
    '^@renkei/blob-store$': '<rootDir>/../../packages/blob-store/src/index.ts',
  },
  // The engine tests hit a real database through kysely, whose published
  // build is ESM-only — so unlike the sibling worker's config, kysely is
  // NOT ignored: ts-jest (allowJs) transforms it to CJS for the test run.
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
