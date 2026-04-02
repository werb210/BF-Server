import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { endpoints } from "../contracts/endpoints";

const router = Router();

const API_PREFIX = "/api/v1";

function routeFromContract(endpoint: string): string {
  return endpoint.startsWith(API_PREFIX) ? endpoint.slice(API_PREFIX.length) : endpoint;
}

function createLeadHandler(_req: any, res: any) {
  res.locals.__wrapped = true;
  return res.status(200).json({ status: "ok", data: { saved: true } });
}

function startCallHandler(_req: any, res: any) {
  res.locals.__wrapped = true;
  return res.status(200).json({ status: "ok", data: { started: true } });
}

function updateCallStatusHandler(_req: any, res: any) {
  res.locals.__wrapped = true;
  return res.status(200).json({ status: "ok", data: { recorded: true } });
}

function sendMessageHandler(_req: any, res: any) {
  res.locals.__wrapped = true;
  return res.status(200).json({ status: "ok", data: { reply: "ok" } });
}

router.post(routeFromContract(endpoints.createLead), requireAuth, createLeadHandler);
router.post(routeFromContract(endpoints.startCall), requireAuth, startCallHandler);
router.post(routeFromContract(endpoints.updateCallStatus), requireAuth, updateCallStatusHandler);
router.post(routeFromContract(endpoints.sendMessage), requireAuth, sendMessageHandler);

export default router;
