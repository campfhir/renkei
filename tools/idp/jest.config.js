export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  // kysely's published build is ESM-only; ts-jest (allowJs) transforms it to
  // CJS for the run — the worker-agents arrangement.
  transformIgnorePatterns: ['/node_modules/(?!.*kysely)'],
  moduleNameMapper: {
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
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
