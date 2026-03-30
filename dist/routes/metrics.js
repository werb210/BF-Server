"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackRequest = trackRequest;
const express_1 = require("express");
const router = (0, express_1.Router)();
let requestCount = 0;
function trackRequest() {
    requestCount++;
}
router.get('/metrics', (_req, res) => {
    res["json"]({
        uptime: process.uptime(),
        requests: requestCount
    });
});
exports.default = router;
