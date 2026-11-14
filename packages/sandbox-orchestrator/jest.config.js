export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@renkei/connector-sandbox$': '<rootDir>/../connector-sandbox/src/index.ts',
    '^@renkei/db$': '<rootDir>/../db/src/index.ts',
  },
  // @renkei/db is loaded from source (the tests run the orchestrator on
  // its memory store) and imports kysely, whose published build is
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
