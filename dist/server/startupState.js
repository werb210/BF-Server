"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.markReady = markReady;
exports.markNotReady = markNotReady;
exports.isReady = isReady;
exports.fetchStatus = fetchStatus;
exports.resetStartupState = resetStartupState;
const state = {
    ready: false,
    reason: "starting",
    startedAt: Date.now(),
};
function markReady() {
    state.ready = true;
    state.reason = null;
}
function markNotReady(reason) {
    state.ready = false;
    state.reason = reason;
}
function isReady() {
    return state.ready;
}
function fetchStatus() {
    return { ...state };
}
function resetStartupState() {
    state.ready = false;
    state.reason = "starting";
    state.startedAt = Date.now();
}
