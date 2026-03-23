import { Router, type RequestHandler } from "express";

const router = Router();

router.get("/test", (_req: any, res: any) => {
  res.json({ ok: true, route: "test" });
});

function mountSafe(path: string, modulePath: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loaded = require(modulePath) as { default?: RequestHandler } | RequestHandler;
    const handler = (loaded as { default?: RequestHandler }).default ?? (loaded as RequestHandler);
    router.use(path, handler);
  } catch (e) {
    console.error("ROUTE LOAD FAIL:", e);
  }
}

mountSafe("/lenders", "./lenders");
mountSafe("/applications", "./applications");
mountSafe("/crm", "./crm");
mountSafe("/users", "./users");
mountSafe("/lender-products", "./lenderProducts");

export default router;
