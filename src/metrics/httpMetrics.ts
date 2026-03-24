import type { NextFunction, Request, Response } from "express";
import client from "prom-client";

export const requestsTotal = new client.Counter({
  name: "requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route"],
});

export const requestErrorsTotal = new client.Counter({
  name: "request_errors_total",
  help: "Total number of HTTP 5xx responses",
  labelNames: ["method", "route", "status"],
});

export const httpRequestDuration = new client.Histogram({
  name: "request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
});

export function httpMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const route = req.route?.path ?? req.path;
  requestsTotal.inc({ method: req.method, route });
  const end = httpRequestDuration.startTimer();

  res.on("finish", () => {
    const status = String(res.statusCode);
    end({
      method: req.method,
      route,
      status,
    });

    if (res.statusCode >= 500) {
      requestErrorsTotal.inc({ method: req.method, route, status });
    }
  });

  next();
}
