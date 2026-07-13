/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Source files use explicit `.js` extensions on relative imports so the emitted ESM build
  // resolves under Node's native ESM loader. ts-jest resolves the .ts sources, so strip the
  // extension back off for test runs.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
