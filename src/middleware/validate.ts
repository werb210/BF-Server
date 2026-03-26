import { Request, Response, NextFunction } from "express";

export function requireFields(fields: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const field of fields) {
      if (!(req.body as Record<string, unknown>)[field]) {
        return res.status(400).json({ error: "invalid_payload" });
      }
    }
    next();
  };
}

export const validationErrorHandler = (err: { type?: string } | undefined, _req: Request, res: Response, next: NextFunction) => {
  if (err?.type === "validation") {
    return res.status(400).json({ error: "invalid_payload" });
  }
  return next(err);
};

// backward compatibility
export const validateBody = requireFields;
