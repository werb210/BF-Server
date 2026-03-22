import { Express } from "express";

export function auditRoutes(app: Express) {
  const routes: string[] = [];

  app._router.stack.forEach((middleware: any) => {
    if (middleware.route) {
      const methods = Object.keys(middleware.route.methods)
        .join(",")
        .toUpperCase();
      routes.push(`${methods} ${middleware.route.path}`);
    } else if (middleware.name === "router") {
      middleware.handle.stack.forEach((handler: any) => {
        if (handler.route) {
          const methods = Object.keys(handler.route.methods)
            .join(",")
            .toUpperCase();
          routes.push(`${methods} ${handler.route.path}`);
        }
      });
    }
  });

  return routes.sort();
}

export function assertCriticalRoutes(app: Express) {
  const routes = auditRoutes(app);

  const required = [
    "GET /health",
    "POST /auth/otp/start",
    "POST /auth/otp/verify"
  ];

  const missing = required.filter(r => !routes.includes(r));

  if (missing.length > 0) {
    console.error("CRITICAL ROUTES MISSING:");
    console.error(missing);
    process.exit(1);
  }

  console.log("ROUTE AUDIT PASSED");
}
