import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { endpoints } from "../contracts/endpoints";
import { ok } from "../lib/response";

const router = Router();

const API_PREFIX = "/api/v1";

function routeFromContract(endpoint: string): string {
  return endpoint.startsWith(API_PREFIX) ? endpoint.slice(API_PREFIX.length) : endpoint;
}

function createLeadHandler(req: any, _res: any) {
  return ok({ saved: true }, req.rid);
}

function startCallHandler(req: any, _res: any) {
  return ok({ started: true }, req.rid);
}

function updateCallStatusHandler(req: any, _res: any) {
  return ok({ recorded: true }, req.rid);
}

function sendMessageHandler(req: any, _res: any) {
  return ok({ reply: "ok" }, req.rid);
}

router.post(routeFromContract(endpoints.createLead), requireAuth, createLeadHandler);
router.post(routeFromContract(endpoints.startCall), requireAuth, startCallHandler);
router.post(routeFromContract(endpoints.updateCallStatus), requireAuth, updateCallStatusHandler);
router.post(routeFromContract(endpoints.sendMessage), requireAuth, sendMessageHandler);

export default router;
