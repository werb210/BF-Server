"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isReady = isReady;
function isReady(deps) {
    return deps.db.ready === true;
}
