"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetStartupState = exports.fetchStatus = exports.isReady = exports.markNotReady = exports.markReady = void 0;
var startupState_1 = require("./server/startupState");
Object.defineProperty(exports, "markReady", { enumerable: true, get: function () { return startupState_1.markReady; } });
Object.defineProperty(exports, "markNotReady", { enumerable: true, get: function () { return startupState_1.markNotReady; } });
Object.defineProperty(exports, "isReady", { enumerable: true, get: function () { return startupState_1.isReady; } });
Object.defineProperty(exports, "fetchStatus", { enumerable: true, get: function () { return startupState_1.fetchStatus; } });
Object.defineProperty(exports, "resetStartupState", { enumerable: true, get: function () { return startupState_1.resetStartupState; } });
