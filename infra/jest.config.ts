import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',
  // Look for tests anywhere under the package root — the `test/` directory
  // is created in Task 1.2 alongside the first stack test.
  roots: ['<rootDir>'],
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'js'],
  clearMocks: true,
  verbose: true,
  // Don't fail CI just because Phase 1.1 hasn't shipped any tests yet.
  // Stacks land with tests in Tasks 1.2+, and passWithNoTests protects the
  // scaffolding-only checkpoint. Remove later if we want strict CI on tests.
  passWithNoTests: true,
};

export default config;
