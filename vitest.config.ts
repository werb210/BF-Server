import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.js',
      'src/test/**/*.ts',
      'src/test/**/*.js',
      '**/*test*.ts',
      '**/*test*.js'
    ],
    exclude: [
      'node_modules',
      'dist'
    ],
    environment: 'node',
    globals: true
  }
});
