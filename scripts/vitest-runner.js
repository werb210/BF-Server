#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const rawArgs = process.argv.slice(2);
const hasRunInBand = rawArgs.includes('--runInBand');
const args = rawArgs.filter((arg) => arg !== '--runInBand');

const commandArgs = hasRunInBand
  ? [
      'vitest',
      'run',
      'tests/routeArtifactExport.test.ts',
      'src/tests/auth.otp.flow.test.ts',
      ...args,
    ]
  : ['vitest', 'run', ...args];

const result = spawnSync('npx', commandArgs, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
