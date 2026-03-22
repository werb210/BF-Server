export function errorHandler(err: any, req: any, res: any, next: any) {
  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
    path: req.originalUrl,
    method: req.method,
  });
}
