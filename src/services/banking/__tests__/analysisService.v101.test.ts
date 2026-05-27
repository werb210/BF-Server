import fs from 'node:fs';
import path from 'node:path';

describe('BF_SERVER_BLOCK_v101_BANKING_CLASSIFIER_MSG_v1', () => {
  it('contains clearer OTHER classification message', () => {
    const src = fs.readFileSync(path.resolve('src/services/banking/bankingAnalysisPipeline.ts'), 'utf8');
    expect(src).toContain('Document classified as financial statement, not bank statement. Try uploading actual bank statements (monthly account activity exports).');
  });
});
