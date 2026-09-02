export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  // The metadata-filter test compiles real SQL through kysely, whose
  // published build is ESM-only — transformed here the way the worker and
  // worker-agents configs already do it. Suites that mock kysely are
  // unaffected.
  transformIgnorePatterns: ['/node_modules/(?!.*kysely)'],
  moduleNameMapper: {
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
    '^@renkei/connector-config$': '<rootDir>/../../packages/connector-config/src/index.ts',
    '^@renkei/gates$': '<rootDir>/../../packages/gates/src/index.ts',
    '^@renkei/agent-llm$': '<rootDir>/../../packages/agent-llm/src/index.ts',
    '^@renkei/settings$': '<rootDir>/../../packages/settings/src/index.ts',
  },
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
