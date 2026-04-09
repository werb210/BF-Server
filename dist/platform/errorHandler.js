export function errorHandler(err, _req, res, _next) {
    console.error("GLOBAL ERROR:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
}
