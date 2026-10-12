// BF_SERVER_v789_SOURCE_GREP - posts a correctly signed SignNow webhook to the real router so tests can
// drive the webhook's branches (PNW, SBA, deferred Owner 2 invite, owner queue walk) by behaviour.
// The calling test file mocks the router's collaborators (db, signnowClient, graph send, ...).
import crypto from "node:crypto";
import express, { type Router } from "express";
import request from "supertest";

export const SIGNNOW_TEST_SECRET = "signnow-webhook-test-secret";

export function signnowWebhookApp(router: Router) {
  const app = express();
  // The handler verifies the HMAC over the raw body, as the app-level parser provides it.
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
  app.use(router);
  return app;
}

export function postSignnowWebhook(app: express.Express, body: Record<string, unknown>) {
  process.env.SIGNNOW_WEBHOOK_SECRET = SIGNNOW_TEST_SECRET;
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac("sha256", SIGNNOW_TEST_SECRET).update(raw).digest("hex");
  return request(app).post("/webhooks/signnow").set("content-type", "application/json").set("x-signnow-signature", sig).send(raw);
}
