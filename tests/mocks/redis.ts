// tests/mocks/redis.ts

const store = new Map<string, string>();

export const redis = {
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: string) => {
    store.set(k, v);
  },
  del: async (k: string) => {
    store.delete(k);
  },
};
