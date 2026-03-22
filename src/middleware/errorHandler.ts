export function errorHandler(err, req, res, next) {
  console.error(err);

  return res.status(err.status || 500).json({
    ok: false,
    error: err.message || "Internal server error"
  });
}
