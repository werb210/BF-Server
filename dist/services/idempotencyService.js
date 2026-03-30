"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveReplay = saveReplay;
const replayStore = new Map();
const REPLAY_TTL_MS = 10 * 60 * 1000;
const MAX_REPLAY_ITEMS = 1000;
function setWithTTL(key, value, ttlMs = REPLAY_TTL_MS) {
    replayStore.set(key, value);
    setTimeout(() => replayStore.delete(key), ttlMs).unref();
    if (replayStore.size > MAX_REPLAY_ITEMS) {
        const firstKey = replayStore.keys().next().value;
        if (firstKey) {
            replayStore.delete(firstKey);
        }
    }
}
function saveReplay(key, payload) {
    if (!replayStore.has(key)) {
        setWithTTL(key, payload);
    }
    return replayStore.get(key);
}
