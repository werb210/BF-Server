"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.respondOk = respondOk;
function respondOk(res, data, meta) {
    if (meta && Object.keys(meta).length > 0) {
        res["json"]({ success: true, data, meta });
        return;
    }
    res["json"]({ success: true, data });
}
