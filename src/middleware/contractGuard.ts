import { Request, Response, NextFunction } from "express";

export function requireFields(fields: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const missing = fields.filter((f) => {
      const v = (req.body ?? {})[f];
      return v === undefined || v === null || v === "";
    });

    if (missing.length > 0) {
      return res.status(400).json({
        error: "Contract violation",
        missing,
        message: "Request does not match API contract"
      });
    }

    next();
  };
}
