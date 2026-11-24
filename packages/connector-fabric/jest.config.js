export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  // kysely ships ESM-only; without this exception ts-jest cannot load it
  // (the carve-out connector-mirth and apps/web make).
  transformIgnorePatterns: ['/node_modules/(?!.*kysely)'],
  moduleNameMapper: {
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/guards$': '<rootDir>/../../packages/guards/src/index.ts',
  },
  transform: {
    '^.+\\.(t|j)sx?$': ['ts-jest', { tsconfig: { esModuleInterop: true } }],
  },
};
