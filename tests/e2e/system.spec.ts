import { test, expect } from '@playwright/test'

const API = 'https://api.staff.boreal.financial'

test('FULL SYSTEM', async ({ page, request }) => {

  // FRONTEND LOAD
  await page.goto('/')
  await expect(page).toHaveTitle(/Boreal/i)

  // API HEALTH
  const health = await request.get(`${API}/health`)
  expect(health.status()).toBe(200)

  // CORE ROUTES EXIST
  const lenders = await request.get(`${API}/api/lenders`)
  expect([200,401]).toContain(lenders.status())

  const apps = await request.get(`${API}/api/applications`)
  expect([200,401]).toContain(apps.status())

  const crm = await request.get(`${API}/api/crm/contacts`)
  expect([200,401]).toContain(crm.status())

})
