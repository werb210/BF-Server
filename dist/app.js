"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
exports.buildAppWithApiRoutes = buildAppWithApiRoutes;
const createServer_1 = require("./server/createServer");
function buildAppWithApiRoutes() {
    return (0, createServer_1.createServer)();
}
exports.app = buildAppWithApiRoutes();
