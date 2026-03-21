import { Request, Response, NextFunction } from "express"

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const message = err?.message || "Internal server error"

  if (message.includes("Missing required environment variable")) {
    return res.status(500).json({
      code: "config_error",
      message,
    })
  }

  if (message.includes("invalid")) {
    return res.status(400).json({
      code: "invalid_request",
      message,
    })
  }

  return res.status(500).json({
    code: "internal_error",
    message,
  })
}
