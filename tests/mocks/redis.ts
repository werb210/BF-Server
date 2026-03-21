// tests/mocks/redis.ts

export const redis = {
  get: async () => null,
  set: async () => 'OK',
  del: async () => 1,
};
