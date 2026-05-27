import fs from 'node:fs';
import path from 'node:path';

describe('BF_SERVER_BLOCK_v103_VOICE_TWIML_LOGGING_v1', () => {
  it('sets answerOnBridge true and callerId for dial', () => {
    const src = fs.readFileSync(path.resolve('src/routes/webhooks.ts'), 'utf8');
    expect(src).toContain('answerOnBridge: true');
    expect(src).toContain('callerId');
  });
});
