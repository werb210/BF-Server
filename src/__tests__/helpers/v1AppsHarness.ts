// BF_SERVER_v789_SG5 - shared harness for behaviour tests of src/routes/client/v1Applications.ts.
// The test file owns its vi.mock calls (they must be hoisted there); this module only mounts the
// router and supplies the SQL rules every submit needs.
import express from "express";
import jwt from "jsonwebtoken";
import type { SqlRule } from "./answerBySql.js";

export const APP_ID = "11111111-2222-4333-8444-555555555555";
export const CLIENT_PHONE = "+17805550100";

export async function buildV1App() {
  const { default: router } = await import("../../routes/client/v1Applications.js");
  const app = express();
  app.use(express.json());
  app.use("/api/client", router);
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = typeof err?.status === "number" ? err.status : 500;
    res.status(status).json({ error: { code: err?.code ?? "internal", message: err?.message ?? "error" } });
  });
  return app;
}

export function clientToken(phone = CLIENT_PHONE): string {
  return jwt.sign({ sub: `client:${phone}`, role: "client", isClient: true, phone }, String(process.env.JWT_SECRET), {
    algorithm: "HS256",
  });
}

/** The router-level param guard looks the id up; answering "no such application" lets the route's own logic run. */
export const PARAM_GUARD_RULE: SqlRule = [/lower\(id::text\) = ANY/, { rows: [] }];

/** loadApplicationByToken answers with the application under test. */
export function submitBaseRules(app: { id?: string; silo?: string; owner_user_id?: string | null } = {}): SqlRule[] {
  return [
    PARAM_GUARD_RULE,
    [/SELECT id, silo, owner_user_id\s+FROM applications/, { rows: [{ id: app.id ?? APP_ID, silo: app.silo ?? "BF", owner_user_id: app.owner_user_id ?? "owner-1" }] }],
  ];
}
