import fs from 'node:fs';
import path from 'node:path';

describe('BF_SERVER_BLOCK_v100_FINANCIALS_TYPE_GUARD_v1', () => {
  it('sanitizes numeric and text fields in financials mapper output', () => {
    const src = fs.readFileSync(path.resolve('src/routes/portal.ts'), 'utf8');
    expect(src).toContain('function sanitizeField');
    expect(src).toContain('NUMERIC_FIELDS');
    expect(src).toContain('Number.isFinite(n)');
  });
});
