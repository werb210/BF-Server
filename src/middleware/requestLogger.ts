import { randomUUID } from "crypto";
import { type NextFunction, type Request, type Response } from "express";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const headerRequestId = req.headers["x-request-id"];
  const id = typeof headerRequestId === "string" && headerRequestId.length > 0 ? headerRequestId : randomUUID();

  req.id = id;
  req.requestId = id;
  res.setHeader("x-request-id", id);

  console.log(
    JSON.stringify({
      event: "request_started",
      request_id: id,
      method: req.method,
      path: req.originalUrl,
    })
  );

  res.on("finish", () => {
    console.log(
      JSON.stringify({
        event: "request_completed",
        request_id: id,
        status: res.statusCode,
      })
    );
  });

  next();
}
