export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/delegate-client$': '<rootDir>/../../packages/delegate-client/src/index.ts',
    '^@renkei/gates$': '<rootDir>/../../packages/gates/src/index.ts',
    '^@renkei/rate-limit$': '<rootDir>/../../packages/rate-limit/src/index.ts',
    '^@renkei/user-keys$': '<rootDir>/../../packages/user-keys/src/index.ts',
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
