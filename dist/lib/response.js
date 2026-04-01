"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.fail = fail;
function ok(res, data) {
    res.locals.__wrapped = true;
    return res.json({ status: "ok", data });
}
function fail(res, codeOrMessage, messageOrCode) {
    const code = typeof codeOrMessage === "number" ? codeOrMessage : Number(messageOrCode ?? 500);
    const message = typeof codeOrMessage === "number" ? String(messageOrCode ?? "error") : codeOrMessage;
    res.locals.__wrapped = true;
    return res.status(code).json({
        status: "error",
        error: { code: String(code), message },
    });
}
