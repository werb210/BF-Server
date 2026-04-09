import { error } from "../lib/response.js";
export function errorHandler(err, req, res, next) {
    const headerRid = req.headers["x-request-id"];
    const rid = req.id ?? req.rid ?? (typeof headerRid === "string" ? headerRid : undefined);
    console.error("SERVER ERROR:", {
        rid,
        path: req.path,
        error: err,
    });
    if (res.headersSent) {
        return next(err);
    }
    return res.status(500).json(error("Internal server error", rid));
}
