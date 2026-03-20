module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/api/**/*.test.ts'],
  globals: {
    'ts-jest': {
      tsconfig: 'jest.tsconfig.json'
    }
  }
}
