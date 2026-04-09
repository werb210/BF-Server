export function validate(schema, target = "body") {
    return (req, res, next) => {
        if (target === "body") {
            const isUploadRoute = req.originalUrl.split("?")[0] === "/api/documents/upload";
            if (req.method === "POST" && !req.is("application/json") && !isUploadRoute) {
                return res.status(415).json({ status: "error", error: "JSON_REQUIRED" });
            }
        }
        const result = schema.safeParse(req[target]);
        if (!result.success) {
            return res.status(400).json({ status: "error", error: "INVALID_INPUT" });
        }
        Object.assign(req, { [target]: result.data });
        if (target === "body") {
            req.validated = result.data;
        }
        return next();
    };
}
export function requireFields(fields) {
    return (req, res, next) => {
        for (const field of fields) {
            if (!req.body || req.body[field] === undefined) {
                return res.status(400).json({ status: "error", error: "INVALID_INPUT" });
            }
        }
        return next();
    };
}
export const validationErrorHandler = (err, _req, res, next) => {
    if (err?.type === "validation") {
        return res.status(400).json({ status: "error", error: "INVALID_INPUT" });
    }
    return next(err);
};
export const validateBody = requireFields;
