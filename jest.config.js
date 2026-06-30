export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  // Compile TypeScript to CJS for tests — avoids the ESM VM-module gotcha
  // where `jest` is not injected as a global in time for top-level jest.mock()
  // calls. The "type":"module" in package.json only affects native Node.js
  // loading; Jest's transformer intercepts before that.
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: false,
      isolatedModules: true,
      tsconfig: { module: 'commonjs' },
    }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testTimeout: 30000,
};

