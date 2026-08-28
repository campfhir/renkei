export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/queue$': '<rootDir>/../../packages/queue/src/index.ts',
    '^@renkei/settings$': '<rootDir>/../../packages/settings/src/index.ts',
    '^@renkei/tool-outcomes$': '<rootDir>/../../packages/tool-outcomes/src/index.ts',
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
