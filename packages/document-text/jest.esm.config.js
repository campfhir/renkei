/**
 * A second jest config, for the PDF tests only.
 *
 * pdfjs-dist is ESM-only, and jest's default CJS runtime cannot `await
 * import()` it — the import fails, extraction reports PDFs unsupported, and
 * the tests fail for a reason that has nothing to do with the code. Mocking
 * pdfjs would make them pass and prove nothing: it is the one dependency this
 * package keeps, so the integration IS the thing worth testing.
 *
 * So these run under Node's real ESM VM modules instead. Kept separate rather
 * than migrating the whole package, because every other suite works fine —
 * and cheaply — under the default config.
 */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/pdf.test.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'esnext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
        },
      },
    ],
  },
};
