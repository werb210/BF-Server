export function requireRole(role) {
    return (req, res, next) => {
        const userRole = req.user?.role;
        if (userRole !== role) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        next();
    };
}
