export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    // Map to source so ts-jest transforms it; the symlinked node_modules copy
    // would be excluded by transformIgnorePatterns.
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
    '^@renkei/email-sanitizer$': '<rootDir>/../../packages/email-sanitizer/src/index.ts',
    '^@renkei/provider-grants$': '<rootDir>/../../packages/provider-grants/src/index.ts',
    '^@renkei/capability-registry$': '<rootDir>/../../packages/capability-registry/src/index.ts',
    '^@renkei/connector-webex$': '<rootDir>/../../packages/connector-webex/src/index.ts',
    '^@renkei/connector-config$': '<rootDir>/../../packages/connector-config/src/index.ts',
    '^@renkei/settings$': '<rootDir>/../../packages/settings/src/index.ts',
    '^@renkei/gates$': '<rootDir>/../../packages/gates/src/index.ts',
    '^@renkei/knowledge$': '<rootDir>/../../packages/knowledge/src/index.ts',
    '^@renkei/queue$': '<rootDir>/../../packages/queue/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          jsx: 'preserve',
          esModuleInterop: true,
        },
      },
    ],
  },
  collectCoverageFrom: ['lib/**/*.ts', '!lib/**/*.test.ts'],
};
