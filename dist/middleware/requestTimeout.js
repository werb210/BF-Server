const REQUEST_TIMEOUT_MS = 5_000;
export function requestTimeout(req, res, next) {
    res.setTimeout(REQUEST_TIMEOUT_MS, () => {
        if (!res.headersSent) {
            res.status(503).json({ error: "timeout" });
        }
    });
    next();
}
