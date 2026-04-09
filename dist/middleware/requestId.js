import { randomUUID } from "node:crypto";
export function requestId(req, res, next) {
    const rid = randomUUID();
    req.rid = rid;
    res.setHeader("x-request-id", rid);
    next();
}
