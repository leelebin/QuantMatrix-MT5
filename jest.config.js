module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  clearMocks: true,
  modulePathIgnorePatterns: [
    '<rootDir>/.claude/',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/.claude/',
  ],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/.claude/',
  ],
};
