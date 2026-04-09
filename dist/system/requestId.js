import { randomUUID } from "node:crypto";
export function requestId() {
    return (req, res, next) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && incoming.trim().length > 0 ? incoming : randomUUID();
        req.rid = id;
        req.requestId = id;
        req.id = id;
        res.locals.requestId = id;
        res.setHeader("x-request-id", id);
        next();
    };
}
