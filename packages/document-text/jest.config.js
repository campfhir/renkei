export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  // pdfjs-dist is ESM-only and cannot be imported by jest's CJS runtime; that
  // suite runs under jest.esm.config.js via `pnpm test:pdf`.
  testPathIgnorePatterns: ['/node_modules/', 'pdf\\.test\\.ts$'],
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
