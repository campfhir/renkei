export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/rate-limit$': '<rootDir>/../../packages/rate-limit/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          esModuleInterop: true,
        },
      },
    ],
  },
};
