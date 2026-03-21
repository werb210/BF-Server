// tests/setupMocks.ts

import { vi } from 'vitest';

// Mock DB layer
vi.mock('@/db', async () => {
  const mod = await import('./mocks/db');
  return { db: mod.db };
});

// Mock Redis layer
vi.mock('@/services/redis', async () => {
  const mod = await import('./mocks/redis');
  return { redis: mod.redis };
});

vi.mock('@/services/twilio', async () => {
  const mod = await import('./mocks/twilio');
  return { client: mod.client };
});
