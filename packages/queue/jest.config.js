export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
  },
  // @renkei/db's client imports kysely, whose published build is ESM-only:
  // transformed to CJS here (ts-jest with allowJs), as apps/worker does.
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
