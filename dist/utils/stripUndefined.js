"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripUndefined = stripUndefined;
function stripUndefined(obj) {
    const result = {};
    for (const key in obj) {
        if (obj[key] !== undefined) {
            result[key] = obj[key];
        }
    }
    return result;
}
