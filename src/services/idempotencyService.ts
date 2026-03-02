const replayStore = new Map<string, any>();

export function saveReplay(key: string, payload: any) {
  if (!replayStore.has(key)) {
    replayStore.set(key, payload);
  }
  return replayStore.get(key);
}
