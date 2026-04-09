export function authMiddleware(req, res, next) {
    // placeholder auth — replace later
    if (!req.headers.authorization) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}
