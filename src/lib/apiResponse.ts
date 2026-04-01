export function ok(data: unknown): { status: "ok"; data: unknown } {
  if (data === undefined) {
    throw new Error("OK_REQUIRES_DATA");
  }
  return { status: "ok", data };
}

export function fail(_res: unknown, code: string, message?: string): { status: "error"; error: { code: string; message?: string } } {
  if (!code) {
    throw new Error("FAIL_REQUIRES_CODE");
  }
  return {
    status: "error",
    error: { code, message },
  };
}
