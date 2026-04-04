"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTokenVersion = getTokenVersion;
exports.bumpTokenVersion = bumpTokenVersion;
const tokenVersionStore = new Map();
function getTokenVersion(userId) {
    return tokenVersionStore.get(userId) || 0;
}
function bumpTokenVersion(userId) {
    tokenVersionStore.set(userId, getTokenVersion(userId) + 1);
}
