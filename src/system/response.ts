export function ok(data: any) {
  return { status: "ok", data };
}

export function fail(error: any) {
  return {
    status: "error",
    error: error?.message || "UNKNOWN",
  };
}
