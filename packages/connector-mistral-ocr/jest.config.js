export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@renkei/connector-config$': '<rootDir>/../../packages/connector-config/src/index.ts',
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
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
