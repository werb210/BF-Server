"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireRole = requireRole;
function requireRole(role) {
    return (req, res, next) => {
        const userRole = req.user?.role;
        if (userRole !== role) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        next();
    };
}
