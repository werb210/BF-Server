import request from 'supertest';
import app from '../index';

describe('API contract', () => {
  it('GET /health returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('POST /api/auth/otp/start exists (not 404)', async () => {
    const res = await request(app)
      .post('/api/auth/otp/start')
      .send({ phone: '5878881837' });

    expect(res.status).not.toBe(404);
  });
});
