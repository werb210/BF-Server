const state = {
    ready: false,
    reason: "starting",
    startedAt: Date.now(),
};
export function markReady() {
    state.ready = true;
    state.reason = null;
}
export function markNotReady(reason) {
    state.ready = false;
    state.reason = reason;
}
export function isReady() {
    return state.ready;
}
export function fetchStatus() {
    return { ...state };
}
export function resetStartupState() {
    state.ready = false;
    state.reason = "starting";
    state.startedAt = Date.now();
}
