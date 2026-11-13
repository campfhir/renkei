export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    // Settings is mocked in every test, but the module path still has to resolve.
    '^@renkei/settings$': '<rootDir>/../settings/src/index.ts',
    '^@renkei/db$': '<rootDir>/../db/src/index.ts',
  },
  // @renkei/db is loaded from source (routing.ts reads which instance a
  // caller is assigned to) and imports kysely, whose published build is
  // ESM-only; ts-jest (allowJs) transforms it to CJS for the run.
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
