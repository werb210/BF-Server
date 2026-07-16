// BF_SERVER_GRAPH_WEBHOOKS_v1 - public endpoint Microsoft Graph calls with the
// subscription validation handshake + change notifications. No auth (Graph is
// anonymous); notifications are verified by clientState against the stored sub.
import { Router } from "express";
import { pool } from "../db.js";
import { handleGraphNotifications } from "../modules/o365/mailSubscriptions.js";

const router = Router();

router.post("/", (req: any, res: any) => {
  const token = req.query?.validationToken;
  if (typeof token === "string") {
    res.status(200).type("text/plain").send(token);
    return;
  }
  res.status(202).send();
  const values = Array.isArray(req.body?.value) ? req.body.value : [];
  if (values.length) void handleGraphNotifications(pool, values);
});

export default router;
