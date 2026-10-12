import fs from "node:fs";
import path from "node:path";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowedLine, hashWatchSecret, issueWatchAccessToken } from "../security.js";
import { decryptWatchPushToken, encryptWatchPushToken } from "../pushTokenCrypto.js";
import { configureWatchPushProvider, sendWatchNotification, WATCH_NOTIFICATION_CATEGORIES } from "../notifications.js";
import { API_ROUTE_MOUNTS } from "../../routes/routeRegistry.js";
import watchAuthRoutes from "../authRoutes.js";
import watchDeviceRoutes from "../deviceRoutes.js";
import watchDataRoutes from "../dataRoutes.js";
import watchCallRoutes from "../callRoutes.js";
import telephonyRoutes from "../../telephony/routes/telephonyRoutes.js";
import voiceCallsRoutes from "../../routes/voiceCalls.js";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("../../middleware/twilioWebhookValidation.js", () => ({ twilioWebhookValidation: (_req: any, _res: any, next: any) => next() }));
vi.mock("../../telephony/services/tokenService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generateVoiceToken: (identity: string) => `voice-token-for-${identity}`,
}));

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const STAFF = "00000000-0000-4000-8000-0000000000a1";
const DEVICE = "dddddddd-0000-4000-8000-000000000001";
const SESSION = "eeeeeeee-0000-4000-8000-000000000001";
const CALL = "ffffffff-0000-4000-8000-000000000001";
const watchToken = () => issueWatchAccessToken(STAFF, DEVICE, SESSION).accessToken;
const staffJwt = () => jwt.sign({ sub: STAFF, id: STAFF, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const mounted = (p: string) => API_ROUTE_MOUNTS.find((m) => m.path === p)!.router;

function app() {
  const a = express();
  a.use(express.json());
  for (const p of ["/watch", "/telephony", "/voice"]) a.use(`/api${p}`, mounted(p));
  return a;
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/FROM watch_sessions s JOIN watch_devices d/, { rows: [{ id: SESSION, staff_user_id: STAFF, role: "Staff", silo: "BF", silos: ["BF"] }] }],
    [/FROM contacts/, { rows: [] }],
  ]));
});
afterEach(() => { configureWatchPushProvider(null); vi.restoreAllMocks(); });

describe("standalone Watch server contract", () => {
  it("mounts auth, device, data, and telephony surfaces without changing iPhone token", async () => {
    const watch = mounted("/watch") as any;
    const handles = watch.stack.map((l: any) => l.handle);
    for (const r of [watchAuthRoutes, watchDeviceRoutes, watchDataRoutes]) expect(handles).toContain(r);
    expect((telephonyRoutes as any).stack.some((l: any) => l.handle === watchCallRoutes && l.regexp.test("/watch/calls"))).toBe(true);
    expect(mounted("/voice")).toBe(voiceCallsRoutes);

    // Watch surfaces answer under /api/watch and /api/telephony/watch, behind Watch auth.
    expect((await request(app()).get("/api/watch/contacts?line=BF&q=ab")).status).toBe(401);
    const call = await request(app()).post("/api/telephony/watch/calls").send({});
    expect(call.status).toBe(401);
    expect(call.body.error.code).toBe("unauthenticated");

    // The iPhone token route still takes the staff JWT, and a Watch token is not a staff token.
    expect((await request(app()).post("/api/voice/token")).status).toBe(401);
    expect((await request(app()).post("/api/voice/token").set("Authorization", `Bearer ${watchToken()}`)).status).toBe(401);
    const ok = await request(app()).post("/api/voice/token").set("Authorization", `Bearer ${staffJwt()}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ token: `voice-token-for-${STAFF}`, identity: STAFF });
  });

  it("persists independently revocable credentials and authoritative bridge state", () => {
    const migration = read("migrations/2026_09_02_v154_watch_backend.sql");
    for (const table of ["watch_devices", "watch_sessions", "watch_push_registrations", "watch_call_bridges"])
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    expect(migration).toContain("refresh_token_hash");
    expect(migration).toContain("revoked_at");
    expect(migration).toContain("UNIQUE(staff_user_id,idempotency_key)");
  });

  it("hashes secrets deterministically without retaining plaintext", () => {
    const secret = "do-not-store-this-watch-secret";
    const hash = hashWatchSecret(secret);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(secret);
    expect(hashWatchSecret(secret)).toBe(hash);
  });

  it("encrypts APNs tokens at rest and decrypts only for transport", () => {
    process.env.WATCH_PUSH_ENCRYPTION_KEY = "test-only-key";
    const token = "a".repeat(64);
    const ciphertext = encryptWatchPushToken(token);
    expect(ciphertext).not.toContain(token);
    expect(decryptWatchPushToken(ciphertext)).toBe(token);
  });

  it("keeps callback selection and connected state server controlled", async () => {
    const auth = { Authorization: `Bearer ${watchToken()}`, "Idempotency-Key": "k-1" };
    const withCallback = await request(app()).post("/api/telephony/watch/calls").set(auth)
      .send({ destination: "+15874441234", line: "BF", callbackNumber: "+15875550000" });
    expect(withCallback.status).toBe(400);
    expect(withCallback.body.error.message).toBe("Callback number is server controlled");
    expect(callsMatching(queryMock, /watch_call_bridges/)).toHaveLength(0);

    const status = (body: Record<string, string>) => request(app()).post(`/api/telephony/watch/provider/${CALL}/status`).type("form").send(body);
    expect((await status({ CallStatus: "in-progress" })).status).toBe(204);
    const [upd] = callsMatching(queryMock, /UPDATE watch_call_bridges SET status=\$2/);
    expect(upd![1]).toEqual([CALL, "connected"]);

    queryMock.mockClear();
    expect((await status({ status: "ended" })).status).toBe(204);
    expect((await status({ CallStatus: "made-up" })).status).toBe(204);
    expect(callsMatching(queryMock, /UPDATE watch_call_bridges/)).toHaveLength(0);
  });

  it("enforces line grants rather than trusting the line query", async () => {
    const req = (silo: string, silos: string[]) => ({ user: { silo, silos } }) as any;
    expect(allowedLine(req("BF", []), "bf")).toBe("BF");
    expect(allowedLine(req("BF", []), "BI")).toBeNull();
    expect(allowedLine(req("BF", ["BI"]), "BI")).toBe("BI");
    expect(allowedLine(req("BF", ["BI"]), "XX")).toBeNull();

    const auth = { Authorization: `Bearer ${watchToken()}` };
    const forbidden = await request(app()).get("/api/watch/contacts?line=BI&q=ab").set(auth);
    expect(forbidden.status).toBe(403);
    expect(callsMatching(queryMock, /FROM contacts/)).toHaveLength(0);

    const res = await request(app()).get("/api/watch/contacts?line=BF&q=ab&limit=999").set(auth);
    expect(res.status).toBe(200);
    const [q] = callsMatching(queryMock, /FROM contacts/);
    expect(q![1]).toEqual(["BF", null, "ab", 26]); // capped at 25 (+1 to detect another page)
  });

  it("allowlists minimal standard-APNs notification payload fields", async () => {
    expect([...WATCH_NOTIFICATION_CATEGORIES]).toEqual(["MESSAGE", "TASK", "MEETING", "MISSED_CALL"]);
    const sent: Array<Record<string, unknown>> = [];
    configureWatchPushProvider({ send: async (_reg, payload) => { sent.push(payload); } });
    const query = vi.fn(async () => ({ rows: [{ id: "r1", device_id: DEVICE, token_ciphertext: "c", environment: "production" }] }));
    const input = {
      staffUserId: STAFF, category: "MESSAGE" as const, eventType: "client_message" as const, title: "New message", body: "Jordan replied", resourceId: "msg_1",
      bankBalance: 120000, creditScore: 780, jwt: "eyJ.secret", apiCredential: "sk-live",
    };
    expect(await sendWatchNotification(input, { query: query as any, decrypt: () => "device-token" })).toBe(1);
    expect(Object.keys(sent[0]!).sort()).toEqual(["aps", "id", "schema", "type"]);
    const json = JSON.stringify(sent[0]);
    for (const sensitive of ["bankBalance", "creditScore", "eyJ.secret", "sk-live", "120000", "780"]) expect(json).not.toContain(sensitive);
  });
});
