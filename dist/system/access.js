import { log } from "./logger.js";
import { incErr } from "./metrics.js";
export function access() {
    return (req, res, next) => {
        const start = Date.now();
        res.on("finish", () => {
            if (res.statusCode >= 500) {
                incErr();
            }
            log("info", "request", {
                rid: req.rid,
                method: req.method,
                path: req.originalUrl,
                status: res.statusCode,
                ms: Date.now() - start,
            });
        });
        next();
    };
}
