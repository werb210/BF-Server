import { Request, Response, NextFunction } from "express"

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const message =
    err?.message || "Internal server error"

  if (message.includes("Missing required environment variable")) {
    return res.status(500).json({
      success: false,
      code: "config_error",
      message,
    })
  }

  return res.status(500).json({
    success: false,
    code: "internal_error",
    message,
  })
}
