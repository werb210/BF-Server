// BF_SERVER_v814_JOURNEY_DETAIL - the contact journey returns the field / button / form names behind each step,
// and only those named keys (nothing else that might sit in an event's meta).
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { mountRouter, staffToken } from "./helpers/staffRouterApp.js";
import { answerBySql } from "./helpers/answerBySql.js";

const query = vi.fn();
vi.mock("../db.js", async () => ({
  ...(await vi.importActual<any>("../db.js")),
  pool: { query: (...args: unknown[]) => query(...args) },
}));

import { journeyDetail } from "../routes/crm.js";

beforeEach(() => query.mockReset());

describe("journeyDetail", () => {
  it("keeps only the named keys, trimmed and capped", () => {
    expect(journeyDetail({ field: " Annual revenue ", value: "250000", email: "a@b.c" })).toEqual({ field: "Annual revenue" });
    expect(journeyDetail('{"form":"Contact us","field":"Phone","fields":3}')).toEqual({ form: "Contact us", field: "Phone", fields: 3 });
    expect(journeyDetail({ label: "x".repeat(200) })?.label).toHaveLength(80);
    expect(journeyDetail(null)).toBeNull();
    expect(journeyDetail("not json")).toBeNull();
    expect(journeyDetail({ value: "secret" })).toBeNull();
  });
});

describe("GET /api/crm/contacts/:id/journey", () => {
  it("returns each event's detail and never the raw meta", async () => {
    query.mockImplementation(answerBySql([
      [/FROM visitor_sessions/, { rows: [{ session_id: "s1", first_seen_at: "2026-10-16T08:00:00Z", last_seen_at: "2026-10-16T08:05:00Z", landing_page: "/" }] }],
      [/FROM applications/, { rows: [] }],
      [/FROM visitor_events/, { rows: [
        { session_id: "s1", event_type: "field_complete", path: "/apply/step-1", title: null, step: "1", dwell_ms: null, occurred_at: "2026-10-16T08:01:00Z", meta: { field: "Annual revenue", secret: "x" } },
        { session_id: "s1", event_type: "pageview", path: "/", title: "Home", step: null, dwell_ms: 4000, occurred_at: "2026-10-16T08:00:00Z", meta: null },
      ] }],
    ] as any));
    const app = mountRouter((await import("../routes/crm.js")).default, "/api/crm");
    const res = await request(app).get("/api/crm/contacts/c1/journey").set("Authorization", `Bearer ${staffToken()}`);
    expect(res.status).toBe(200);
    const events = (res.body.data ?? res.body).events;
    expect(events[0].detail).toEqual({ field: "Annual revenue" });
    expect(events[1].detail).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("secret");
    expect(events[0]).not.toHaveProperty("meta");
  });
});
