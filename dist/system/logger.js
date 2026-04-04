"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = log;
function log(level, msg, ctx = {}) {
    console.log(JSON.stringify({
        level,
        msg,
        time: new Date().toISOString(),
        ...ctx,
    }));
}
