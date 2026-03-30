"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.send = void 0;
exports.send = {
    ok: (res, data = { ok: true }) => res["json"](data),
    error: (res, status, msg) => res.status(status).json({ error: msg }),
};
