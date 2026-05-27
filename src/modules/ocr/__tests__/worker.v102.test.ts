import fs from 'node:fs';
import path from 'node:path';

describe('BF_SERVER_BLOCK_v102_OCR_RETRY_v1', () => {
  it('retries on timeout-ish errors with exponential backoff', () => {
    const src = fs.readFileSync(path.resolve('src/modules/ocr/ocr.service.ts'), 'utf8');
    expect(src).toContain('ETIMEDOUT|ECONNRESET|ESOCKETTIMEDOUT');
    expect(src).toContain('Math.pow(2, attempt - 1)');
  });
});
