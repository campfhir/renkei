export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  // `*.integration.test.ts` hits a real Atlassian sandbox over the network
  // and needs credentials from .env.development that this config never
  // loads — see jest.integration.config.js. Left in the default glob, a
  // laptop without those vars (or CI) would get real network failures
  // indistinguishable from a broken test.
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.test\\.ts$'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    // Map to source so ts-jest transforms it; the symlinked node_modules copy
    // would be excluded by transformIgnorePatterns.
    '^@renkei/agents$': '<rootDir>/../../packages/agents/src/index.ts',
    '^@renkei/agents/runs$': '<rootDir>/../../packages/agents/src/runs.ts',
    '^@renkei/agent-llm$': '<rootDir>/../../packages/agent-llm/src/index.ts',
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
    '^@renkei/email-sanitizer$': '<rootDir>/../../packages/email-sanitizer/src/index.ts',
    '^@renkei/provider-grants$': '<rootDir>/../../packages/provider-grants/src/index.ts',
    '^@renkei/capability-registry$': '<rootDir>/../../packages/capability-registry/src/index.ts',
    '^@renkei/connector-webex$': '<rootDir>/../../packages/connector-webex/src/index.ts',
    '^@renkei/connector-config$': '<rootDir>/../../packages/connector-config/src/index.ts',
    '^@renkei/settings$': '<rootDir>/../../packages/settings/src/index.ts',
    '^@renkei/gates$': '<rootDir>/../../packages/gates/src/index.ts',
    '^@renkei/redaction$': '<rootDir>/../../packages/redaction/src/index.ts',
    '^@renkei/document-text$': '<rootDir>/../../packages/document-text/src/index.ts',
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
