// v123-test-ratchet
// Runs the full suite and compares the failure count against a committed
// baseline. Fewer failures than baseline -> baseline is lowered and the run
// passes. More -> the run fails. Equal -> passes but prints the remaining
// work. The count can only ever go down, so a red main cannot get redder.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const BASELINE = 'ci-failure-baseline.json';
const RESULTS = '/tmp/v123-results.json';

spawnSync('npx', ['vitest', 'run', '--reporter=json', '--outputFile=' + RESULTS], {
  stdio: 'inherit',
  shell: false,
});

let raw;
try {
  raw = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
} catch (err) {
  console.error('V123 FAIL: could not read vitest json output: ' + err.message);
  process.exit(1);
}

const failures = [];
for (const suite of raw.testResults || []) {
  const file = String(suite.name || '').replace(process.cwd() + '/', '');
  for (const a of suite.assertionResults || []) {
    if (a.status !== 'failed') continue;
    failures.push({
      file,
      name: a.fullName || a.title || '',
      message: String((a.failureMessages || [])[0] || '').split('\n')[0].slice(0, 160),
    });
  }
}

const count = failures.length;

let baseline = null;
if (fs.existsSync(BASELINE)) {
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).failures;
  } catch (err) {
    baseline = null;
  }
}

console.log('');
console.log('V123 failing assertions now: ' + count);
console.log('V123 baseline: ' + (baseline === null ? 'none (establishing)' : baseline));

const byFile = new Map();
for (const f of failures) byFile.set(f.file, (byFile.get(f.file) || 0) + 1);
console.log('');
console.log('V123 REMAINING BY FILE');
[...byFile.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([file, n]) => console.log('  ' + String(n).padStart(3) + '  ' + file));
console.log('');
console.log('V123 REMAINING DETAIL');
failures.slice(0, 80).forEach((f) => {
  console.log('  ' + f.file);
  console.log('    > ' + f.name);
  console.log('    ! ' + f.message);
});

function writeBaseline(n) {
  fs.writeFileSync(
    BASELINE,
    JSON.stringify({ failures: n, note: 'v123 ratchet - this number may only decrease' }, null, 2) + '\n',
    'utf8',
  );
}

if (baseline === null) {
  writeBaseline(count);
  console.log('V123 baseline established at ' + count);
  process.exit(0);
}

if (count > baseline) {
  console.error('V123 FAIL: failures went UP (' + baseline + ' -> ' + count + ')');
  process.exit(1);
}

if (count < baseline) {
  writeBaseline(count);
  console.log('V123 RATCHET: ' + baseline + ' -> ' + count + ' (' + (baseline - count) + ' fixed)');
  process.exit(0);
}

console.log('V123 no change: ' + count + ' still failing');
process.exit(0);
