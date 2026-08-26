export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  // kysely ships ESM-only; without this exception ts-jest cannot load it
  // (same carve-out apps/web's jest config makes).
  transformIgnorePatterns: ['/node_modules/(?!.*kysely)'],
  moduleNameMapper: {
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/rate-limit$': '<rootDir>/../../packages/rate-limit/src/index.ts',
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
