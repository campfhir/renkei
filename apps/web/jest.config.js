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
    '^@renkei/agents/step-prompts$': '<rootDir>/../../packages/agents/src/step-prompts.ts',
    '^@renkei/agent-llm$': '<rootDir>/../../packages/agent-llm/src/index.ts',
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
    '^@renkei/notifications$': '<rootDir>/../../packages/notifications/src/index.ts',
    '^@renkei/email-sanitizer$': '<rootDir>/../../packages/email-sanitizer/src/index.ts',
    '^@renkei/provider-grants$': '<rootDir>/../../packages/provider-grants/src/index.ts',
    '^@renkei/capability-registry$': '<rootDir>/../../packages/capability-registry/src/index.ts',
    '^@renkei/connector-webex$': '<rootDir>/../../packages/connector-webex/src/index.ts',
    '^@renkei/connector-fileshares$': '<rootDir>/../../packages/connector-fileshares/src/index.ts',
    '^@renkei/fileshares-client$': '<rootDir>/../../packages/fileshares-client/src/index.ts',
    '^@renkei/sandbox-client$': '<rootDir>/../../packages/sandbox-client/src/index.ts',
    '^@renkei/batch-jobs-store$': '<rootDir>/../../packages/batch-jobs-store/src/index.ts',
    '^@renkei/connector-mistral-ocr$': '<rootDir>/../../packages/connector-mistral-ocr/src/index.ts',
    '^@renkei/connector-onbase$': '<rootDir>/../../packages/connector-onbase/src/index.ts',
    '^@renkei/connector-fileshares/pure$':
      '<rootDir>/../../packages/connector-fileshares/src/pure.ts',
    '^@renkei/connector-config$': '<rootDir>/../../packages/connector-config/src/index.ts',
    '^@renkei/settings$': '<rootDir>/../../packages/settings/src/index.ts',
    '^@renkei/tool-outcomes$': '<rootDir>/../../packages/tool-outcomes/src/index.ts',
    '^@renkei/user-prefs$': '<rootDir>/../../packages/user-prefs/src/index.ts',
    '^@renkei/user-prefs/prefs$': '<rootDir>/../../packages/user-prefs/src/prefs.ts',
    '^@renkei/gates$': '<rootDir>/../../packages/gates/src/index.ts',
    '^@renkei/redaction$': '<rootDir>/../../packages/redaction/src/index.ts',
    '^@renkei/document-text$': '<rootDir>/../../packages/document-text/src/index.ts',
    '^@renkei/knowledge$': '<rootDir>/../../packages/knowledge/src/index.ts',
    '^@renkei/queue$': '<rootDir>/../../packages/queue/src/index.ts',
    '^@renkei/mcp-client$': '<rootDir>/../../packages/mcp-client/src/index.ts',
    '^@renkei/blob-store$': '<rootDir>/../../packages/blob-store/src/index.ts',
  },
  // kysely's published build is ESM-only, and quickjs-emscripten's CJS
  // build keeps a dynamic import() for its wasm variant; suites importing
  // package barrels that reach either need them transformed to CJS rather
  // than ignored — the worker-agents pattern.
  transformIgnorePatterns: ['/node_modules/(?!.*(kysely|quickjs))'],
  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        tsconfig: {
          jsx: 'preserve',
          esModuleInterop: true,
          allowJs: true,
        },
      },
    ],
  },
  collectCoverageFrom: ['lib/**/*.ts', '!lib/**/*.test.ts'],
};
