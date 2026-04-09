import { fail, ok } from "./response.js";
import { ok as respondOk, error as respondError } from "../lib/respond.js";
export function wrap(handler) {
    return async (req, res) => {
        try {
            const result = await handler(req, res);
            if (!res.headersSent) {
                respondOk(res, ok(result, req.rid));
            }
        }
        catch (err) {
            if (!res.headersSent) {
                const status = err.status || 500;
                if (status === 429) {
                    res.setHeader("Retry-After", "1");
                }
                respondError(res, fail(err, req.rid).error, status);
            }
        }
    };
}
