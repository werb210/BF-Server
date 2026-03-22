import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

type Context = {
  requestId: string;
  path: string;
  method: string;
};

const storage = new AsyncLocalStorage<Context>();

export function requestContextMiddleware(req: any, res: any, next: any) {
  const context: Context = {
    requestId: req.headers["x-request-id"] || randomUUID(),
    path: req.originalUrl,
    method: req.method,
  };

  storage.run(context, () => {
    res.setHeader("X-Request-Id", context.requestId);
    next();
  });
}

export function getRequestContext(): Context | undefined {
  return storage.getStore();
}
