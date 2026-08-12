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
    '^@renkei/email-sanitizer$': '<rootDir>/../../packages/email-sanitizer/src/index.ts',
    '^@renkei/connector-config$': '<rootDir>/../../packages/connector-config/src/index.ts',
    '^@renkei/connector-atlassian$': '<rootDir>/../../packages/connector-atlassian/src/index.ts',
    '^@renkei/connector-webex$': '<rootDir>/../../packages/connector-webex/src/index.ts',
    '^@renkei/gates$': '<rootDir>/../../packages/gates/src/index.ts',
    '^@renkei/knowledge$': '<rootDir>/../../packages/knowledge/src/index.ts',
    '^@renkei/settings$': '<rootDir>/../../packages/settings/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          esModuleInterop: true,
        },
      },
    ],
  },
};
