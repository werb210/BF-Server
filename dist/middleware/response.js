"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrap = wrap;
exports.okResponse = okResponse;
exports.ok = okResponse;
exports.fail = fail;
const contracts_1 = require("../contracts");
const response_1 = require("../lib/response");
function resolveRid(req) {
    const headerRid = req.headers["x-request-id"];
    const requestRid = req.id ?? req.rid;
    if (typeof requestRid === "string" && requestRid.length > 0) {
        return requestRid;
    }
    if (typeof headerRid === "string" && headerRid.length > 0) {
        return headerRid;
    }
    return undefined;
}
function sendValidatedResponse(res, payload) {
    const validated = contracts_1.ApiResponseSchema.safeParse(payload);
    if (!validated.success) {
        console.error("INVALID RESPONSE SHAPE:", payload);
        return res.status(500).json((0, response_1.fail)("Invalid response shape", resolveRid(res.req)));
    }
    return res.status(200).send(validated.data);
}
function wrap(handler) {
    return async (req, res, next) => {
        const rid = resolveRid(req);
        try {
            const result = await handler(req, res, next);
            if (res.headersSent) {
                return;
            }
            const payload = !result || typeof result !== "object" || !("status" in result) ? (0, response_1.ok)(result ?? null, rid) : result;
            res.locals.__wrapped = true;
            return sendValidatedResponse(res, payload);
        }
        catch (err) {
            return next(err);
        }
    };
}
function okResponse(res, data, statusCode = 200) {
    res.locals.__wrapped = true;
    return res
        .status(statusCode)
        .json((0, response_1.ok)(data ?? null, res.getHeader("x-request-id") ?? undefined));
}
function fail(res, a, b) {
    const rid = res.getHeader("x-request-id") ?? undefined;
    if (typeof a === "number") {
        const message = typeof b === "string" ? b : "Request failed";
        res.locals.__wrapped = true;
        return res.status(a).json((0, response_1.fail)(message, rid));
    }
    const message = a;
    const statusCode = typeof b === "number" ? b : 400;
    res.locals.__wrapped = true;
    return res.status(statusCode).json((0, response_1.fail)(message, rid));
}
