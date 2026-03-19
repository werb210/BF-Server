type Entry = {
  value: string;
  expiresAt: number | null;
};

const store = new Map<string, Entry>();

function isExpired(entry: Entry): boolean {
  return entry.expiresAt !== null && Date.now() > entry.expiresAt;
}

function getEntry(key: string): Entry | null {
  const entry = store.get(key);
  if (!entry) return null;

  if (isExpired(entry)) {
    store.delete(key);
    return null;
  }

  return entry;
}

export const redis = {
  async set(key: string, val: string, mode?: "EX", ttlSeconds?: number) {
    const expiresAt = mode === "EX" && typeof ttlSeconds === "number"
      ? Date.now() + ttlSeconds * 1000
      : null;

    store.set(key, { value: val, expiresAt });
  },

  async get(key: string) {
    const entry = getEntry(key);
    return entry ? entry.value : null;
  },

  async del(key: string) {
    store.delete(key);
  },

  async ttl(key: string) {
    const entry = getEntry(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;

    const remainingMs = entry.expiresAt - Date.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : -2;
  },
};
