import fs from 'node:fs';
import path from 'node:path';

describe('BF_SERVER_BLOCK_v104_SSE_HEARTBEAT_v1', () => {
  it('writes keep-alive heartbeat comments for SSE', () => {
    const src = fs.readFileSync(path.resolve('src/voice/sseBus.ts'), 'utf8');
    expect(src).toContain(': keep-alive');
    expect(src).toContain('30_000');
  });
});
