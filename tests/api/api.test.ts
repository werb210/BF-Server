import { describe, it, expect } from 'vitest';
import request from 'supertest'

const BASE = 'https://api.staff.boreal.financial'

describe('API SYSTEM', () => {

  it('health works', async () => {
    const res = await request(BASE).get('/health')
    expect(res.status).toBe(200)
  })

  it('lenders route exists', async () => {
    const res = await request(BASE).get('/api/lenders')
    expect([200,401]).toContain(res.status)
  })

  it('applications route exists', async () => {
    const res = await request(BASE).get('/api/applications')
    expect([200,401]).toContain(res.status)
  })

  it('crm route exists', async () => {
    const res = await request(BASE).get('/api/crm/contacts')
    expect([200,401]).toContain(res.status)
  })

})
