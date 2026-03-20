import request from 'supertest';
import { describe, it, expect } from 'vitest';
import app from '../../src/app'; // adjust if your entry differs

describe('E2E: health + basic routes', () => {
  it('GET /health returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('GET / returns 200', async () => {
    const res = await request(app).get('/');
    expect([200, 301, 302]).toContain(res.status);
  });
});
