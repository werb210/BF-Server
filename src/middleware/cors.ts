import { Request, Response, NextFunction } from "express";
import { ENV } from "../config/env";

const allowedOrigins = [
  ENV.CLIENT_URL,
  ENV.PORTAL_URL,
  "https://server.boreal.financial",
  "https://staff.boreal.financial",
  "https://client.boreal.financial",
];

export function corsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
}
