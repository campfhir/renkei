export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@renkei/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@renkei/crypto$': '<rootDir>/../../packages/crypto/src/index.ts',
    '^@renkei/connector-config$': '<rootDir>/../../packages/connector-config/src/index.ts',
    '^@renkei/gates$': '<rootDir>/../../packages/gates/src/index.ts',
    '^@renkei/knowledge$': '<rootDir>/../../packages/knowledge/src/index.ts',
  },
  // quickjs-emscripten's CJS build keeps a dynamic import() for its wasm
  // variant, which jest's CJS vm cannot service — transforming the package
  // (allowJs + module commonjs) rewrites it to require, the kysely pattern.
  transformIgnorePatterns: ['/node_modules/(?!.*quickjs)'],
  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        tsconfig: {
          esModuleInterop: true,
          allowJs: true,
          module: 'commonjs',
        },
      },
    ],
  },
};
