import { vi } from 'vitest';

(global as any).jest = {
  fn: vi.fn,
  mock: vi.mock,
  clearAllMocks: vi.clearAllMocks,
};
