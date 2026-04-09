import type { NextFunction, Request, Response } from "express";
import { ApiResponseSchema } from "../contracts/index.js";
import { error, ok } from "../lib/response.js";

type WrappedBody = {
  status?: string;
};

type WrappedHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

function resolveRid(req: Request): string | undefined {
  const headerRid = req.headers["x-request-id"];
  const requestRid = req.id ?? req.rid;

  if (typeof requestRid === "string" && requestRid.length > 0) {
    return requestRid;
  }

  if (typeof headerRid === "string" && headerRid.length > 0) {
    return headerRid;
  }

  return undefined;
}

function sendValidatedResponse(res: Response, payload: unknown): Response {
  const validated = ApiResponseSchema.safeParse(payload);

  if (!validated.success) {
    console.error("INVALID RESPONSE SHAPE:", payload);
    return res.status(500).json(error("Invalid response shape", resolveRid(res.req)));
  }

  return res.status(200).send(validated.data);
}

export function wrap(handler: WrappedHandler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const rid = resolveRid(req);

    try {
      const result = await handler(req, res, next);

      if (res.headersSent) {
        return;
      }

      const payload = !result || typeof result !== "object" || !("status" in (result as WrappedBody)) ? ok(result ?? null, rid) : result;

      res.locals.__wrapped = true;
      return sendValidatedResponse(res, payload);
    } catch (err) {
      return next(err);
    }
  };
}

export function okResponse(res: Response, data?: unknown, statusCode = 200): Response {
  res.locals.__wrapped = true;
  return res
    .status(statusCode)
    .json(ok(data ?? null, (res.getHeader("x-request-id") as string | undefined) ?? undefined));
}

export function fail(res: Response, a: number | string, b?: string | number): Response {
  const rid = (res.getHeader("x-request-id") as string | undefined) ?? undefined;

  if (typeof a === "number") {
    const message = typeof b === "string" ? b : "Request failed";
    res.locals.__wrapped = true;
    return res.status(a).json(error(message, rid));
  }

  const message = a;
  const statusCode = typeof b === "number" ? b : 400;
  res.locals.__wrapped = true;
  return res.status(statusCode).json(error(message, rid));
}

export { okResponse as ok, error };
