/**
 * A second jest config, for tests that hit a real Atlassian instance.
 *
 * Every other suite here stubs the network — same idiom document-text uses to
 * separate its pdfjs integration test from everything else it can test
 * cheaply. This is the same split for a different reason: not a runtime
 * incompatibility, but credentials. `*.integration.test.ts` needs a real
 * account and a real sandbox, which most environments running `pnpm test`
 * (a laptop with no .env.development, CI) do not have and should not need.
 *
 * Kept out of the default config's glob (see jest.config.js) so `pnpm test`
 * never depends on network access or secrets; run this one explicitly with
 * `pnpm test:integration`, after `.env.development` carries
 * TEST_JIRA_USER_NAME, TEST_JIRA_API_TOKEN and TEST_JIRA_SANDBOX_API_BASE_URL.
 * Suites skip themselves — not fail — when those are absent, so a checkout
 * without sandbox access can still run this script and see why nothing ran.
 */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.integration.test.ts'],
  setupFiles: ['<rootDir>/jest.env-integration.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
    '^@renkei/notifications$': '<rootDir>/../../packages/notifications/src/index.ts',
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
};
