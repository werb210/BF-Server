"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const express_1 = require("express");
async function createServer() {
    const router = (0, express_1.Router)();
    router.get('/health', (_req, res) => {
        res.status(200).send('OK');
    });
    return router;
}
