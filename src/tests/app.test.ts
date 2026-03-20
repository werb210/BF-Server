import request from 'supertest';
import app, { appReady } from '../index';

describe('API smoke', () => {
  beforeAll(async () => {
    await appReady;
  });

  it('GET /health = 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('POST /api/auth/otp/start exists', async () => {
    const res = await request(app)
      .post('/api/auth/otp/start')
      .send({ phone: '5878881837' });

    expect(res.status).not.toBe(404);
  });
});
