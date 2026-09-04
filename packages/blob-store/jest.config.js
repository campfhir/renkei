export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
    '^@renkei/connector-config$': '<rootDir>/../../packages/connector-config/src/index.ts',
  },
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
