"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runtimeHandler = void 0;
const runtimeHandler = (req, res) => {
    res["json"]({
        status: "ok",
        uptime: process.uptime(),
    });
};
exports.runtimeHandler = runtimeHandler;
