export const ok = (data: any) => ({
  status: "ok",
  data,
});

export const fail = (error: string) => ({
  status: "error",
  error: {
    message: error,
  },
});

export function sendSuccess(res: any, data: any, code = 200) {
  return res.status(code).json(ok(data));
}

export function sendError(res: any, error: any, code = 500) {
  const normalized =
    typeof error === "string"
      ? { message: error }
      : { ...(error ?? {}), message: error?.message || "Unknown error" };

  return res.status(code).json({
    status: "error",
    error: normalized,
  });
}
