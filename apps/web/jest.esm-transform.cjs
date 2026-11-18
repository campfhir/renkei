/**
 * Jest's transform for ESM-only packages whose classes must stay classes
 * (jose's errors extend Error): TypeScript's transpileModule to CommonJS
 * at ES2022, nothing else changed. ts-jest's own pass lowered them to a
 * form that cannot construct ("Must call super constructor…").
 */
const ts = require('typescript');

module.exports = {
  process(sourceText, sourcePath) {
    const out = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions: {
        allowJs: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        sourceMap: false,
      },
    });
    return { code: out.outputText };
  },
};
