export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    // Mocked in every test, but the module path still has to resolve.
    '^@renkei/settings$': '<rootDir>/../settings/src/index.ts',
    '^@renkei/db$': '<rootDir>/../db/src/index.ts',
  },
  transform: {
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
