export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@renkei/document-text$': '<rootDir>/../document-text/src/index.ts',
  },
  // pptxgenjs's own CJS build keeps a dynamic import() (for its wasm
  // variant, for node:fs) that Jest's CJS sandbox cannot run unless it too
  // is transformed — hence '.js' in the transform pattern below, not just
  // '.ts', and pptxgenjs excluded from transformIgnorePatterns. Same fix as
  // apps/web's own jest config.
  transformIgnorePatterns: ['/node_modules/(?!.*pptxgenjs)'],
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
