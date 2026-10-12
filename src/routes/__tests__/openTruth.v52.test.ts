// BF_SERVER_OPEN_TRUTH_v52
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
import emailPixel from "../emailPixel.js";
import { loadCrmTimeline } from "../crm/timeline.js";
import { classifyOpenSource, isOwnTrackingPixel, MACHINE_SOURCES } from "../openTruth.js";

describe("classifyOpenSource", () => {
  it("classifies providers, scanners, bots, and likely readers", () => {
    expect(classifyOpenSource("Mozilla/5.0 (compatible; GoogleImageProxy)")).toBe("proxy_gmail");
    expect(classifyOpenSource("Mozilla/5.0 AppleMail/16.0")).toBe("proxy_apple");
    expect(classifyOpenSource("Proofpoint URL Defense")).toBe("scanner");
    expect(classifyOpenSource("Mimecast Link Protection")).toBe("scanner");
    expect(classifyOpenSource("Microsoft Office Existence Discovery")).toBe("scanner");
    expect(classifyOpenSource("curl/8.4.0")).toBe("bot");
    expect(classifyOpenSource("node-fetch/1.0")).toBe("bot");
    expect(classifyOpenSource("Mozilla/5.0 (Macintosh) Chrome/127")).toBe("human_likely");
    expect(classifyOpenSource("Microsoft Outlook 16.0")).toBe("human_likely");
    expect(classifyOpenSource("")).toBe("unknown");
    expect(classifyOpenSource(null)).toBe("unknown");
  });

  it("defines only automated sources as machines", () => {
    for (const source of MACHINE_SOURCES) {
      expect(["proxy_gmail", "proxy_apple", "scanner", "bot"]).toContain(source);
    }
  });
});

describe("isOwnTrackingPixel", () => {
  it("recognises tracking pixels without rejecting genuine images", () => {
    expect(isOwnTrackingPixel("https://server.boreal.financial/api/track/email/abc123.gif")).toBe(true);
    expect(isOwnTrackingPixel("https://cdn.example.com/logo.png")).toBe(false);
    expect(isOwnTrackingPixel("https://example.com/api/track/email/other.png")).toBe(false);
    expect(isOwnTrackingPixel("not a url")).toBe(false);
  });
});

describe("recording", () => {
  const app = express();
  app.set("trust proxy", true);
  app.use("/api/track", emailPixel);
  const OPEN_EVENT = /INSERT INTO email_open_events/;
  beforeEach(() => { h.query.mockReset(); h.query.mockImplementation(answerBySql([], { rows: [], rowCount: 1 })); });

  it("records explainable, deduplicated events", async () => {
    const r = await request(app).get("/api/track/email/tok-123.gif").set("User-Agent", "Proofpoint URL Defense").set("X-Forwarded-For", "203.0.113.9, 10.0.0.1");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/gif");
    const [sql, params] = callsMatching(h.query, OPEN_EVENT)[0] as [string, unknown[]];
    expect(sql).toContain("(email_log_id, opened_at, user_agent, ip, source)");
    // the same source on the same email within a minute is one open
    expect(sql).toMatch(/ev\.source = \$4\s+AND ev\.opened_at > now\(\) - interval '1 minute'/);
    expect(params).toEqual(["tok-123", "Proofpoint URL Defense", "203.0.113.9", "scanner"]);
    // the first-open stamp still happens
    expect(callsMatching(h.query, /UPDATE crm_email_log SET opened_at = now\(\)/)[0][1]).toEqual(["tok-123"]);
  });

  it("never blocks the pixel on a database error", async () => {
    h.query.mockImplementation(answerBySql([[OPEN_EVENT, new Error("db down")]]));
    const r = await request(app).get("/api/track/email/tok-9.gif").set("User-Agent", "Microsoft Outlook 16.0");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/gif");
  });

  it("reports the split between people and machines on the timeline", async () => {
    for (const isContact of [true, false]) {
      h.query.mockClear();
      await loadCrmTimeline(isContact, "c-1", "BF");
      const sql = h.query.mock.calls.map((c) => String(c[0])).join("\n");
      expect(sql, String(isContact)).toContain("|| oc.machine || ' machine)");
      expect(sql).toContain("count(*) FILTER (WHERE ev.source IN ('proxy_gmail', 'proxy_apple', 'scanner', 'bot'))::int AS machine");
      expect(sql).toContain("count(*) FILTER (WHERE ev.source = 'unverified')::int AS unverified");
    }
  });
});
