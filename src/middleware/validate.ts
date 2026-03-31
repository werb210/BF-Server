import { NextFunction, Request, Response } from "express";

export function requireFields(fields: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const field of fields) {
      if (!req.body || (req.body as Record<string, unknown>)[field] === undefined) {
        return res.status(400).json({ error: "INVALID_INPUT" });
      }
    }

    next();
  };
}

export const validationErrorHandler = (
  err: { type?: string } | undefined,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (err?.type === "validation") {
    return res.status(400).json({ error: "INVALID_INPUT" });
  }

  return next(err);
};

export const validateBody = requireFields;
