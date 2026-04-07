"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deps = exports.globalState = void 0;
const globalScope = globalThis;
exports.globalState = globalScope.__BF_STATE__ || (globalScope.__BF_STATE__ = {
    metrics: { requests: 0, errors: 0 },
    rateLimit: { window: 0, count: 0 },
});
exports.deps = {
    db: {
        ready: false,
        client: null,
    },
    metrics: exports.globalState.metrics,
    rateLimit: exports.globalState.rateLimit,
};
