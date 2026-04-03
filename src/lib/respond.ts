export function ok(res: any, data: any = {}) {
  return res.status(200).json({
    status: "ok",
    data,
  });
}

export function error(res: any, message = "error", code = 500) {
  return res.status(code).json({
    status: "error",
    error: message,
  });
}
