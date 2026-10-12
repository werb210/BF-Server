// BF_SERVER_v789_SG6 - mount a staff router behind a signed staff token, for behaviour tests.
// The test setup installs a permissive staff-user loader, so any token signed here is accepted.
import express, { type Router } from "express";
import jwt from "jsonwebtoken";

export const STAFF_USER_ID = "00000000-0000-4000-8000-0000000000a1";

export function staffToken(role: "Admin" | "Staff" = "Admin", sub: string = STAFF_USER_ID): string {
  return jwt.sign({ sub, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET), { algorithm: "HS256" });
}

export function mountRouter(router: Router, base: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(base, router);
  return app;
}
