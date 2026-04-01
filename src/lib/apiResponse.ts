export function ok(data: unknown) {
  return { status: "ok", data, error: null };
}

export function fail(code: string, message: string) {
  return { status: "error", data: null, error: { code, message } };
}
