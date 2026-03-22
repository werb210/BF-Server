import { Request, Response, NextFunction } from "express";

export function requireFields(fields: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const field of fields) {
      if (!(req.body as any)[field]) {
        return res.status(400).json({
          ok: false,
          error: `Missing field: ${field}`
        });
      }
    }
    next();
  };
}

// backward compatibility
export const validateBody = requireFields;
