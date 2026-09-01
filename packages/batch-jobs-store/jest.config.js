export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  // schedules.test.ts hits a real database through kysely, whose published
  // build is ESM-only — transformed here the same way apps/worker's config
  // does. Suites that mock kysely (store.test.ts) are unaffected.
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
