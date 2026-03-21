import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';

describe('API contract', () => {
  it('health works', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('otp route exists', async () => {
    const res = await request(app)
      .post('/api/auth/otp/start')
      .send({ phone: '5878881837' });

    expect(res.status).not.toBe(404);
  });
});
