export function requireAuth(req: any, res: any, next: any) {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  next();
}
