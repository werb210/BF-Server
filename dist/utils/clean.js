"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripUndefined = void 0;
exports.toNullable = toNullable;
exports.toStringSafe = toStringSafe;
const stripUndefined_1 = require("./stripUndefined");
Object.defineProperty(exports, "stripUndefined", { enumerable: true, get: function () { return stripUndefined_1.stripUndefined; } });
function toNullable(value) {
    return value === undefined ? null : value;
}
function toStringSafe(value) {
    if (value === undefined || value === null)
        return "";
    return String(value);
}
