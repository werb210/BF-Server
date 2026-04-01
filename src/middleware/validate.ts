import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";

export function validate<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (
      req.method === "POST" &&
      !req.is("application/json") &&
      !req.path.includes("/upload")
    ) {
      return res.status(415).json({
        success: false,
        error: "JSON_REQUIRED",
      });
    }

    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error.message,
      });
    }

    req.validated = result.data;
    return next();
  };
}

export function requireFields(fields: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const field of fields) {
      if (!req.body || (req.body as Record<string, unknown>)[field] === undefined) {
        return res.status(400).json({ success: false, error: "INVALID_INPUT" });
      }
    }

    return next();
  };
}

export const validationErrorHandler = (
  err: { type?: string } | undefined,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (err?.type === "validation") {
    return res.status(400).json({ success: false, error: "INVALID_INPUT" });
  }

  return next(err);
};

export const validateBody = requireFields;
