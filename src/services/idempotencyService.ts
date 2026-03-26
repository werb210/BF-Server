const replayStore = new Map<string, any>();
const REPLAY_TTL_MS = 10 * 60 * 1000;
const MAX_REPLAY_ITEMS = 1000;

function setWithTTL(key: string, value: any, ttlMs = REPLAY_TTL_MS): void {
  replayStore.set(key, value);
  setTimeout(() => replayStore.delete(key), ttlMs).unref();
  if (replayStore.size > MAX_REPLAY_ITEMS) {
    const firstKey = replayStore.keys().next().value;
    if (firstKey) {
      replayStore.delete(firstKey);
    }
  }
}

export function saveReplay(key: string, payload: any) {
  if (!replayStore.has(key)) {
    setWithTTL(key, payload);
  }
  return replayStore.get(key);
}
