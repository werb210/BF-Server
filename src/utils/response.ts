export function ok(data: any = {}) {
  return { ok: true, data };
}

export function fail(error: string, code = 400) {
  return { ok: false, error, code };
}
