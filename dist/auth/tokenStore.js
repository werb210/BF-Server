const tokenVersionStore = new Map();
export function getTokenVersion(userId) {
    return tokenVersionStore.get(userId) || 0;
}
export function bumpTokenVersion(userId) {
    tokenVersionStore.set(userId, getTokenVersion(userId) + 1);
}
