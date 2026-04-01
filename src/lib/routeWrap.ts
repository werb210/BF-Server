import type { NextFunction, Request, RequestHandler, Response } from "express";

type RouteHandler = (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>;

type Envelope =
  | { status: "ok"; data: unknown }
  | { status: "error"; error: { code: string; message?: string } };

function isEnvelope(value: unknown): value is Envelope {
  return Boolean(
    value &&
      typeof value === "object" &&
      "status" in value &&
      ((value as { status?: string }).status === "ok" || (value as { status?: string }).status === "error"),
  );
}

export function wrap(handler: RouteHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      const result = await handler(req, res, next);

      if (res.headersSent) {
        return;
      }

      if (!result) {
        res.status(500).json({
          status: "error",
          error: { code: "EMPTY_RESPONSE" },
        });
        return;
      }

      if (!isEnvelope(result)) {
        res.status(500).json({
          status: "error",
          error: { code: "INVALID_RESPONSE_SHAPE" },
        });
        return;
      }

      if (result.status === "ok") {
        res.json(result);
        return;
      }

      res.status(400).json(result);
    } catch (err: any) {
      res.status(500).json({
        status: "error",
        error: {
          code: err?.code || "UNHANDLED_ROUTE",
          message: err?.message,
        },
      });
    }
  };
}

