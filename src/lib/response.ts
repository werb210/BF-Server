import type { Response } from "express";

export function ok(res: Response, data: unknown): Response {
  res.locals.__wrapped = true;
  return res.json({ status: "ok", data });
}

export function fail(res: Response, codeOrMessage: number | string, messageOrCode?: string | number): Response {
  const code = typeof codeOrMessage === "number" ? codeOrMessage : Number(messageOrCode ?? 500);
  const message = typeof codeOrMessage === "number" ? String(messageOrCode ?? "error") : codeOrMessage;

  res.locals.__wrapped = true;
  return res.status(code).json({
    status: "error",
    error: { code: String(code), message },
  });
}
