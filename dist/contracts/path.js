"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripPrefix = stripPrefix;
function stripPrefix(fullPath, prefix) {
    if (!fullPath.startsWith(prefix)) {
        throw new Error(`Invalid contract path: ${fullPath} does not start with ${prefix}`);
    }
    const out = fullPath.slice(prefix.length);
    return out.startsWith("/") ? out : `/${out}`;
}
