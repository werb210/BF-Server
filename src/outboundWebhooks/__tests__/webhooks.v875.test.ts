// BF_SERVER_v875_WEBHOOKS - outgoing webhooks: the signature a receiver checks, the SSRF guard, the event bodies,
// retries with backoff, giving up, disabling an endpoint (410 Gone from a turned-off Zap) and telling the Admins, and
// batching several events into one signed JSON array. The database is a fake that answers by SQL content.
import { describe, expect, it } from "vitest";
import { signatureHeaders, verifySignature, newSecret, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../signing.js";
import { checkUrlShape, checkWebhookUrl, isBlockedAddress } from "../ssrf.js";
import { EVENTS, EVENT_TYPES, buildBody, sampleBody } from "../events.js";
import { RETRY, backoffMs, deliverBatch, deliverOne, planRequests, runDueDeliveries, type ClaimedDelivery, type TransportRequest } from "../deliver.js";

type Row = Record<string, any>;
function fakeDb(deliveries: Row[], endpoint: Row = { id: "ep1", status: "active", consecutive_failures: 0, silo: "BF" }) {
  const notifications: Row[] = [];
  const db = {
    endpoint,
    notifications,
    query: async (sql: string, params: any[] = []) => {
      if (/WITH due AS/.test(sql)) {
        const due = deliveries.filter((d) => d.status === "pending").slice(0, params[0]);
        for (const d of due) d.status = "sending";
        return { rows: due.map((d) => ({ ...d })) };
      }
      if (/UPDATE webhook_deliveries SET status = 'succeeded'/.test(sql)) {
        Object.assign(deliveries.find((d) => d.id === params[0])!, { status: "succeeded", attempts: params[1], last_status_code: params[2] });
        return { rows: [] };
      }
      if (/UPDATE webhook_deliveries SET status = 'pending'/.test(sql)) {
        Object.assign(deliveries.find((d) => d.id === params[0])!, { status: "pending", attempts: params[1], next_attempt_at: params[2], last_status_code: params[3], last_error: params[4] });
        return { rows: [] };
      }
      if (/UPDATE webhook_deliveries SET status = 'dead'/.test(sql)) {
        Object.assign(deliveries.find((d) => d.id === params[0])!, { status: "dead", attempts: params[1], last_status_code: params[2], last_error: params[3] });
        return { rows: [] };
      }
      if (/UPDATE webhook_deliveries SET status = 'skipped'/.test(sql)) {
        Object.assign(deliveries.find((d) => d.id === params[0])!, { status: "skipped", last_error: params[1] });
        return { rows: [] };
      }
      if (/SET consecutive_failures = 0, last_success_at/.test(sql)) { endpoint.consecutive_failures = 0; return { rows: [] }; }
      if (/SET consecutive_failures = consecutive_failures \+ 1/.test(sql)) { endpoint.consecutive_failures += 1; return { rows: [{ consecutive_failures: endpoint.consecutive_failures }] }; }
      if (/SET last_failure_at = now\(\) WHERE id/.test(sql)) return { rows: [] };
      if (/SET status = 'disabled'/.test(sql)) {
        if (endpoint.status !== "active") return { rows: [] };
        endpoint.status = "disabled"; endpoint.disabled_reason = params[1];
        return { rows: [{ id: endpoint.id, silo: endpoint.silo }] };
      }
      if (/FROM users/.test(sql)) return { rows: [{ id: "admin-1" }, { id: "admin-2" }] };
      if (/INSERT INTO notifications/.test(sql)) { notifications.push({ user_id: params[1], body: params[2] }); return { rows: [] }; }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    },
  };
  return db;
}

const SECRET = "whsec_test_secret_value";
function delivery(id: string, extra: Row = {}): ClaimedDelivery & Row {
  return {
    id, event_id: `evt-${id}`, endpoint_id: "ep1", silo: "BF", event_type: "contact.created", object_type: "contact",
    occurred_at: "2026-11-16T10:00:00.000Z", payload: { object: { id: `c-${id}`, first_name: "Jordan", email: "j@example.com", ssn_encrypted: "x" } },
    attempts: 0, url: "https://hooks.zapier.com/hooks/catch/1/abc/", endpoint_status: "active", secret: SECRET, batch_size: 1,
    status: "pending", ...extra,
  } as any;
}
const answer = (status: number, sent: TransportRequest[] = []) => ({
  transport: async (req: TransportRequest) => { sent.push(req); return { status, body: status === 200 ? "ok" : "nope" }; },
  now: () => 1_767_225_600_000,
  rand: () => 0.5,
});

describe("signing", () => {
  it("a receiver can verify the body with the endpoint secret; tampering, staleness and the wrong secret fail", () => {
    const body = JSON.stringify({ id: "e1" });
    const now = 1_767_225_600_000;
    const h = signatureHeaders(SECRET, body, now);
    expect(h[TIMESTAMP_HEADER]).toBe("1767225600");
    expect(verifySignature(SECRET, h[SIGNATURE_HEADER]!, body, now)).toEqual({ ok: true });
    expect(verifySignature(SECRET, h[SIGNATURE_HEADER]!, body + " ", now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature("whsec_other", h[SIGNATURE_HEADER]!, body, now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature(SECRET, h[SIGNATURE_HEADER]!, body, now + 10 * 60_000)).toEqual({ ok: false, reason: "stale" });
    expect(newSecret()).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
  });
});

describe("SSRF guard", () => {
  it("only public HTTPS addresses", async () => {
    expect(checkUrlShape("http://hooks.zapier.com/x").ok).toBe(false);
    expect(checkUrlShape("https://localhost/x").ok).toBe(false);
    expect(checkUrlShape("https://10.0.0.5/x").ok).toBe(false);
    expect(checkUrlShape("https://user:pw@hooks.zapier.com/x").ok).toBe(false);
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("168.63.129.16")).toBe(true);
    const rebinding = await checkWebhookUrl("https://evil.example.com/hook", async () => [{ address: "192.168.1.10", family: 4 }]);
    expect(rebinding.ok).toBe(false);
    const zapier = await checkWebhookUrl("https://hooks.zapier.com/hooks/catch/1/abc/", async () => [{ address: "54.86.1.1", family: 4 }]);
    expect(zapier.ok).toBe(true);
  });
});

describe("events", () => {
  it("covers contacts, applications and stage changes, documents, offers and funded deals", () => {
    expect(EVENT_TYPES).toEqual(expect.arrayContaining([
      "contact.created", "contact.updated", "application.created", "application.stage_changed", "document.uploaded",
      "offer.created", "offer.status_changed", "deal.funded",
    ]));
    expect(EVENTS.map((e) => e.type)).toEqual([...EVENT_TYPES]);
  });

  it("sends only the listed fields (never secrets) and keeps the silo; the sample shows the stage change", () => {
    const body = JSON.parse(buildBody(delivery("d1")));
    expect(body).toMatchObject({ id: "evt-d1", type: "contact.created", silo: "BF", data: { object: { object: "contact", id: "c-d1", first_name: "Jordan" } } });
    expect(JSON.stringify(body)).not.toContain("ssn_encrypted");
    expect(sampleBody("application.stage_changed", "e", "BI")).toMatchObject({ silo: "BI", data: { from_stage: "Documents Required", to_stage: "In Review", object: { stage: "In Review" } } });
    expect(sampleBody("offer.status_changed")).toMatchObject({ data: { from_status: "pending", to_status: "accepted" } });
  });
});

describe("delivery", () => {
  it("a 2xx marks it delivered, with the signed headers a receiver needs", async () => {
    const rows = [delivery("d1")];
    const db = fakeDb(rows);
    const sent: TransportRequest[] = [];
    expect(await deliverOne(db, rows[0]!, answer(200, sent))).toBe("succeeded");
    expect(rows[0]).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(sent[0]!.headers).toMatchObject({ "X-Webhook-Event": "contact.created", "X-Webhook-Id": "evt-d1", "X-Webhook-Attempt": "1" });
    expect(verifySignature(SECRET, sent[0]!.headers[SIGNATURE_HEADER]!, sent[0]!.body, 1_767_225_600_000)).toEqual({ ok: true });
  });

  it("a 500 is retried later with backoff; the tenth failure gives up", async () => {
    const rows = [delivery("d1")];
    const db = fakeDb(rows);
    expect(await deliverOne(db, rows[0]!, answer(500))).toBe("retry");
    expect(rows[0]).toMatchObject({ status: "pending", attempts: 1, last_status_code: 500 });
    expect(new Date(rows[0]!.next_attempt_at).getTime()).toBe(1_767_225_600_000 + 60_000);
    expect(backoffMs(3, () => 0.5)).toBe(4 * 60_000);
    expect(backoffMs(50, () => 0.5)).toBe(RETRY.maxMs);
    const last = delivery("d2", { attempts: RETRY.maxAttempts - 1 });
    rows.push(last);
    expect(await deliverOne(db, last, answer(500))).toBe("dead");
    expect(db.endpoint.status).toBe("active");
  });

  it("410 Gone (a Zap turned off) disables the endpoint at once and tells every Admin", async () => {
    const rows = [delivery("d1")];
    const db = fakeDb(rows);
    expect(await deliverOne(db, rows[0]!, answer(410))).toBe("dead");
    expect(db.endpoint.status).toBe("disabled");
    expect(db.notifications.map((n) => n.user_id)).toEqual(["admin-1", "admin-2"]);
    expect(db.notifications[0]!.body).toContain("hooks.zapier.com");
  });

  it("a paused endpoint's deliveries are skipped, not sent", async () => {
    const rows = [delivery("d1", { endpoint_status: "paused" })];
    const db = fakeDb(rows);
    const sent: TransportRequest[] = [];
    expect(await deliverOne(db, rows[0]!, answer(200, sent))).toBe("skipped");
    expect(sent).toHaveLength(0);
  });
});

describe("batching", () => {
  it("planRequests splits an endpoint's due events into batches of its size, oldest first", () => {
    const at = { a: "10:01", b: "10:02", c: "10:03" } as const;
    const list = (["c", "a", "b"] as const).map((id) => delivery(id, { batch_size: 2, occurred_at: `2026-11-16T${at[id]}:00.000Z` }));
    expect(planRequests(list).map((g) => g.map((d) => d.id))).toEqual([["a", "b"], ["c"]]);
    expect(planRequests([delivery("x"), delivery("y")]).map((g) => g.length)).toEqual([1, 1]);
  });

  it("sends one signed JSON array (Zapier Catch Hook runs once per item) and records the answer on each delivery", async () => {
    const rows = [delivery("d1", { batch_size: 10 }), delivery("d2", { batch_size: 10, event_type: "application.stage_changed", object_type: "application", payload: { object: { id: "app1", pipeline_state: "In Review" }, extra: { from_stage: "Received", to_stage: "In Review" } } })];
    const db = fakeDb(rows);
    const sent: TransportRequest[] = [];
    expect(await deliverBatch(db, rows, answer(200, sent))).toEqual(["succeeded", "succeeded"]);
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]!.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((b: any) => b.type)).toEqual(["contact.created", "application.stage_changed"]);
    expect(body[1].data).toMatchObject({ from_stage: "Received", to_stage: "In Review", object: { stage: "In Review" } });
    expect(sent[0]!.headers).toMatchObject({ "X-Webhook-Event": "batch", "X-Webhook-Batch-Size": "2" });
    expect(verifySignature(SECRET, sent[0]!.headers[SIGNATURE_HEADER]!, sent[0]!.body, 1_767_225_600_000)).toEqual({ ok: true });
    expect(rows.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("runDueDeliveries claims what is due and sends each endpoint's events in batches", async () => {
    const rows = [1, 2, 3].map((n) => delivery(`d${n}`, { batch_size: 2 }));
    const db = fakeDb(rows);
    const sent: TransportRequest[] = [];
    expect(await runDueDeliveries(db, answer(200, sent))).toBe(3);
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[0]!.body)).toHaveLength(2); // a batch of two
    expect(JSON.parse(sent[1]!.body)).toMatchObject({ id: "evt-d3", type: "contact.created" }); // the one left over, sent alone
    expect(rows.every((r) => r.status === "succeeded")).toBe(true);
  });
});
