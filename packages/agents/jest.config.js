export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  // kysely ships ESM-only; without this exception ts-jest cannot load it
  // (same carve-out connector-fileshares' and notifications' jest configs
  // make — this is the first test in this package to import it at runtime
  // rather than only for types).
  transformIgnorePatterns: ['/node_modules/(?!.*kysely)'],
  moduleNameMapper: {
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/queue$': '<rootDir>/../../packages/queue/src/index.ts',
    '^@renkei/settings$': '<rootDir>/../../packages/settings/src/index.ts',
    '^@renkei/tool-outcomes$': '<rootDir>/../../packages/tool-outcomes/src/index.ts',
  },
  transform: {
    // (t|j)s so the un-ignored kysely ESM is compiled to CJS as well.
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        tsconfig: {
          esModuleInterop: true,
        },
      },
    ],
  },
};
