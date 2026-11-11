export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  // runs.test.ts registers a memory data store from @renkei/db's barrel, which
  // also loads kysely — an ESM-only build that has to be transformed.
  transformIgnorePatterns: ['/node_modules/(?!.*kysely)'],
  moduleNameMapper: {
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/queue$': '<rootDir>/../../packages/queue/src/index.ts',
    '^@renkei/settings$': '<rootDir>/../../packages/settings/src/index.ts',
    '^@renkei/tool-outcomes$': '<rootDir>/../../packages/tool-outcomes/src/index.ts',
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
